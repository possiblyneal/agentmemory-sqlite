import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SqliteState } from "../src/engine/inproc/state.js";
import { KV } from "../src/state/schema.js";
import {
  runStartupMaintenance,
  STARTUP_MAINTENANCE_VERSION,
} from "../src/state/startup-maintenance.js";

const MAX = 3;

function ids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

// #11: rows written before the provenance bound existed are still unbounded on
// disk, and the deleted engine's index shards still occupy the store. One pass
// repairs both, once.
describe("startup maintenance", () => {
  let store: SqliteState;

  beforeEach(() => {
    process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = String(MAX);
    store = new SqliteState(":memory:");
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];
    store.close();
  });

  it("trims over-bound provenance to the cap, keeping the newest ids", async () => {
    store.set(KV.graphNodes, "node-1", {
      id: "node-1",
      name: "auth",
      sourceObservationIds: ids("obs", 10),
    });

    const result = await runStartupMaintenance(store);

    expect(result.skipped).toBe(false);
    expect(result.rowsTrimmed).toBe(1);
    expect(result.idsDropped).toBe(7);
    const node = store.get(KV.graphNodes, "node-1") as {
      name: string;
      sourceObservationIds: string[];
    };
    expect(node.sourceObservationIds).toEqual(["obs-7", "obs-8", "obs-9"]);
    expect(node.name).toBe("auth");
  });

  it("leaves rows already within the bound untouched", async () => {
    store.set(KV.graphEdges, "edge-1", {
      id: "edge-1",
      sourceObservationIds: ["a", "b"],
    });
    store.set(KV.graphNodes, "node-1", { id: "node-1" });

    const result = await runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(0);
    expect(
      (store.get(KV.graphEdges, "edge-1") as { sourceObservationIds: string[] })
        .sourceObservationIds,
    ).toEqual(["a", "b"]);
    expect(store.get(KV.graphNodes, "node-1")).toEqual({ id: "node-1" });
  });

  it("trims nodes and edges alike", async () => {
    store.set(KV.graphNodes, "node-1", { sourceObservationIds: ids("n", 5) });
    store.set(KV.graphEdges, "edge-1", { sourceObservationIds: ids("e", 6) });

    const result = await runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(2);
    expect(result.idsDropped).toBe(2 + 3);
  });

  it("deletes the dead index scopes and nothing else", async () => {
    store.set(KV.bm25Index, "data:manifest", { generation: 4 });
    store.set(KV.bm25Index, "checkpoint:rollback", { at: 1 });
    store.set(`${KV.bm25Index}:bm25:4:0001`, "data", { postings: [] });
    store.set(`${KV.bm25Index}:vectors:4:0002`, "data", { vectors: [] });
    store.set(KV.observations("sess-1"), "obs-1", { id: "obs-1", content: "keep me" });
    store.set(KV.graphNodes, "node-1", { sourceObservationIds: ["a"] });

    const result = await runStartupMaintenance(store);

    expect(result.deadIndexRowsDeleted).toBe(4);
    expect(store.list(KV.bm25Index)).toEqual([]);
    expect(store.list(`${KV.bm25Index}:bm25:4:0001`)).toEqual([]);
    expect(store.list(`${KV.bm25Index}:vectors:4:0002`)).toEqual([]);
    expect(store.get(KV.observations("sess-1"), "obs-1")).toEqual({
      id: "obs-1",
      content: "keep me",
    });
    expect(store.get(KV.graphNodes, "node-1")).toEqual({
      sourceObservationIds: ["a"],
    });
  });

  it("records the version so a second run is a no-op", async () => {
    store.set(KV.graphNodes, "node-1", { sourceObservationIds: ids("obs", 10) });

    expect((await runStartupMaintenance(store)).skipped).toBe(false);
    expect(store.get(KV.state, "system:startupMaintenanceVersion")).toBe(
      STARTUP_MAINTENANCE_VERSION,
    );

    store.set(KV.graphNodes, "node-2", { sourceObservationIds: ids("later", 9) });
    const second = await runStartupMaintenance(store);

    expect(second).toEqual({
      skipped: true,
      rowsTrimmed: 0,
      idsDropped: 0,
      fileNodesMerged: 0,
      edgesChanged: 0,
      deadIndexRowsDeleted: 0,
    });
    expect(
      (store.get(KV.graphNodes, "node-2") as { sourceObservationIds: string[] })
        .sourceObservationIds,
    ).toHaveLength(9);
  });

  it("applies the write path's dedupe rule to a repaired row", async () => {
    // A row written by the merge path before the bound existed can carry the
    // same id twice; the newest sighting is the one that survives (#3).
    store.set(KV.graphNodes, "node-1", {
      sourceObservationIds: ["a", "b", "c", "d", "a"],
    });

    const result = await runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(1);
    expect(
      (store.get(KV.graphNodes, "node-1") as { sourceObservationIds: string[] })
        .sourceObservationIds,
    ).toEqual(["c", "d", "a"]);
    expect(result.idsDropped).toBe(2);
  });

  it("trims every row when the scan spans more than one chunk", async () => {
    // More rows than CHUNK_ROWS, so the pass pages and yields mid-scan. Paging
    // is by seq, which survives the in-place rewrite of rows already passed.
    for (let i = 0; i < 1200; i++) {
      store.set(KV.graphNodes, `node-${i}`, { sourceObservationIds: ids("o", 5) });
    }

    const result = await runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(1200);
    expect(
      (store.get(KV.graphNodes, "node-1199") as { sourceObservationIds: string[] })
        .sourceObservationIds,
    ).toEqual(["o-2", "o-3", "o-4"]);
  });

  it("skips a row whose provenance is missing or malformed", async () => {
    store.set(KV.graphNodes, "node-1", { id: "node-1" });
    store.set(KV.graphNodes, "node-2", { sourceObservationIds: "not-an-array" });

    const result = await runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(0);
    expect(store.get(KV.graphNodes, "node-2")).toEqual({
      sourceObservationIds: "not-an-array",
    });
  });

  it("trims obs-nodes rows, Insight sources and Semantic Fact sources to their caps, newest kept", async () => {
    store.set(KV.graphObsNodes, "obs-1", ids("n", 10));
    store.set(KV.graphObsNodes, "obs-2", ["a", "b"]);
    store.set(KV.insights, "ins-1", { id: "ins-1", title: "t", sourceMemoryIds: ids("m", 130) });
    store.set(KV.semantic, "sem-1", { id: "sem-1", fact: "f", sourceSessionIds: ids("s", 101) });

    const result = await runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(3);
    expect(store.get(KV.graphObsNodes, "obs-1")).toEqual(["n-7", "n-8", "n-9"]);
    expect(store.get(KV.graphObsNodes, "obs-2")).toEqual(["a", "b"]);
    const insight = store.get(KV.insights, "ins-1") as { title: string; sourceMemoryIds: string[] };
    expect(insight.title).toBe("t");
    expect(insight.sourceMemoryIds).toEqual(ids("m", 130).slice(30));
    const fact = store.get(KV.semantic, "sem-1") as { fact: string; sourceSessionIds: string[] };
    expect(fact.fact).toBe("f");
    expect(fact.sourceSessionIds).toEqual(ids("s", 101).slice(1));
  });
});

describe("startup maintenance: duplicate file nodes", () => {
  let store: SqliteState;
  let dir: string;
  let main: string;
  let worktree: string;

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
  const fileNode = (id: string, name: string, obs: string[], at: string) => ({
    id,
    type: "file",
    name,
    properties: {},
    sourceObservationIds: obs,
    createdAt: at,
  });
  const edge = (id: string, source: string, target: string, obs: string[] = []) => ({
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 0.5,
    sourceObservationIds: obs,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const nodeIds = (): string[] =>
    (store.list(KV.graphNodes) as Array<{ id: string }>).map((n) => n.id).sort();
  const snapshotOfStore = (): string =>
    JSON.stringify([
      store.list(KV.graphNodes),
      store.list(KV.graphEdges),
      store.list(KV.graphObsNodes),
      store.list(KV.graphNameIndex),
    ]);

  beforeEach(() => {
    process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = "4";
    mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
    dir = realpathSync(mkdtempSync(join(process.cwd(), "tmp", "merge-files-")));
    main = join(dir, "main");
    worktree = join(dir, "wt");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", worktree);

    store = new SqliteState(":memory:");
    store.set(KV.sessions, "s1", { id: "s1", cwd: main });
    store.set(KV.graphNodes, "keep", fileNode("keep", `${main}/src/a.ts`, ["o1", "o2"], "2026-01-01T00:00:00.000Z"));
    store.set(KV.graphNodes, "dup", fileNode("dup", `${worktree}/src/a.ts`, ["o3", "o4", "o5"], "2026-02-01T00:00:00.000Z"));
    store.set(KV.graphNodes, "other", fileNode("other", "/elsewhere/b.ts", ["o6"], "2026-01-01T00:00:00.000Z"));
    store.set(KV.graphNodes, "concept", {
      id: "concept",
      type: "concept",
      name: "auth",
      properties: {},
      sourceObservationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.set(KV.graphNameIndex, `file|${main}/src/a.ts`, "keep");
    store.set(KV.graphNameIndex, `file|${worktree}/src/a.ts`, "dup");
    store.set(KV.graphEdges, "e-keep", edge("e-keep", "concept", "keep"));
    store.set(KV.graphEdges, "e-dup", edge("e-dup", "concept", "dup", ["o9"]));
    store.set(KV.graphEdges, "e-other", edge("e-other", "dup", "other"));
    store.set(KV.graphEdges, "e-self", edge("e-self", "keep", "dup"));
    store.set(KV.graphEdgeKey, "concept|keep|related_to", "e-keep");
    store.set(KV.graphEdgeKey, "concept|dup|related_to", "e-dup");
    store.set(KV.graphObsNodes, "o4", ["dup", "concept"]);
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges the worktree copy into one node named by the relative path", async () => {
    const result = await runStartupMaintenance(store);

    expect(result.fileNodesMerged).toBe(1);
    expect(nodeIds()).toEqual(["concept", "keep", "other"]);
    const merged = store.get(KV.graphNodes, "keep") as {
      name: string;
      sourceObservationIds: string[];
    };
    expect(merged.name).toBe("src/a.ts");
    expect(merged.sourceObservationIds).toEqual(["o2", "o3", "o4", "o5"]);
    expect(store.get(KV.graphNameIndex, "file|src/a.ts")).toBe("keep");
    expect(store.get(KV.graphNameIndex, `file|${worktree}/src/a.ts`)).toBeNull();
    expect(store.get(KV.graphNodes, "other")).toMatchObject({ name: "/elsewhere/b.ts" });
    expect(store.get(KV.graphObsNodes, "o4")).toEqual(["keep", "concept"]);
  });

  it("re-points edges, folding a collision into its twin and dropping self-loops", async () => {
    const result = await runStartupMaintenance(store);

    expect(store.get(KV.graphEdges, "e-self")).toBeNull();
    expect(store.get(KV.graphEdges, "e-dup")).toBeNull();
    expect(store.get(KV.graphEdges, "e-keep")).toMatchObject({ sourceObservationIds: ["o9"] });
    expect(store.get(KV.graphEdges, "e-other")).toMatchObject({
      sourceNodeId: "keep",
      targetNodeId: "other",
    });
    expect(store.get(KV.graphEdgeKey, "keep|other|related_to")).toBe("e-other");
    expect(result.edgesChanged).toBe(3);
  });

  it("running the whole pass twice leaves the store as one run did", async () => {
    await runStartupMaintenance(store);
    const once = snapshotOfStore();
    store.delete(KV.state, "system:startupMaintenanceVersion");

    const again = await runStartupMaintenance(store);

    expect(again.rowsTrimmed).toBe(0);
    expect(again.fileNodesMerged).toBe(0);
    expect(again.edgesChanged).toBe(0);
    expect(snapshotOfStore()).toBe(once);
  });
});
