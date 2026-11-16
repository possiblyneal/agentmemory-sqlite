import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { graphCounts, graphWaitWanted, hasSummary, waitForGraphQuiet } from "../eval/runner/graph-wait.js";
import { KV } from "../src/state/schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(rows: Array<[string, string]>): string {
  const dir = mkdtempSync(join(process.cwd(), "tmp/graph-wait-"));
  dirs.push(dir);
  const path = join(dir, "s.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key))");
  const put = db.prepare("INSERT INTO kv VALUES (?, ?, '{}', 1)");
  for (const [scope, key] of rows) put.run(scope, key);
  db.close();
  return path;
}

describe("graphWaitWanted", () => {
  it("waits only when extraction is on and the leg is not killed", () => {
    expect(graphWaitWanted({ GRAPH_EXTRACTION_ENABLED: "true" })).toBe(true);
    expect(graphWaitWanted({})).toBe(false);
    expect(graphWaitWanted({ GRAPH_EXTRACTION_ENABLED: "true", AGENTMEMORY_GRAPH_LEG: "off" })).toBe(false);
  });
});

describe("graphCounts", () => {
  it("counts nodes, edges, obs-nodes and whether the read indexes are armed", () => {
    const path = store([
      [KV.graphNodes, "n1"],
      [KV.graphNodes, "n2"],
      [KV.graphEdges, "e1"],
      [KV.graphObsNodes, "o1"],
      [KV.graphIndexMeta, "ready"],
      [KV.sessions, "s1"],
    ]);
    expect(graphCounts(path)).toEqual({ nodes: 2, edges: 1, obsNodes: 1, indexesReady: true });
  });

  it("reports an empty, unarmed graph as zeros", () => {
    expect(graphCounts(store([[KV.sessions, "s1"]]))).toEqual({ nodes: 0, edges: 0, obsNodes: 0, indexesReady: false });
  });
});

describe("waitForGraphQuiet", () => {
  it("returns once the graph rows stop changing for the quiet period", async () => {
    const path = store([[KV.graphNodes, "n1"]]);
    const t0 = Date.now();
    await waitForGraphQuiet(path, { pollMs: 10, quietPolls: 3 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("hasSummary", () => {
  it("is true only for a Session whose Summary row is stored", () => {
    const path = store([[KV.summaries, "s1"]]);
    expect(hasSummary(path, "s1")).toBe(true);
    expect(hasSummary(path, "s2")).toBe(false);
  });
});
