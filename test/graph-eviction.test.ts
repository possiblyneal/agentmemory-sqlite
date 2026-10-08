import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import {
  GRAPH_WRITE_LOCK,
  SNAPSHOT_KEY,
  edgeIndexKey,
  nameIndexKey,
  persistGraphDelta,
} from "../src/functions/graph.js";
import {
  evictGraphForSources,
  sweepOrphanedGraph,
} from "../src/functions/graph-eviction.js";
import { loadNameCatalog } from "../src/state/graph-indexes.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import type { AuditEntry, GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";

type KVMock = ReturnType<typeof mockKV>;

const CREATED = "2026-01-01T00:00:00.000Z";

function node(id: string, sources: string[]): GraphNode {
  return {
    id,
    type: "file",
    name: `src/${id}.ts`,
    properties: {},
    sourceObservationIds: sources,
    createdAt: CREATED,
  };
}

function edge(id: string, from: string, to: string, sources: string[]): GraphEdge {
  return {
    id,
    type: "imports",
    sourceNodeId: from,
    targetNodeId: to,
    weight: 1,
    sourceObservationIds: sources,
    createdAt: CREATED,
  };
}

async function storeObservation(kv: KVMock, id: string): Promise<void> {
  await kv.set(KV.observations("ses_1"), id, { id, sessionId: "ses_1" });
}

async function snapshot(kv: KVMock): Promise<GraphSnapshot> {
  return (await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY))!;
}

async function graphAudits(kv: KVMock): Promise<AuditEntry[]> {
  return (await kv.list<AuditEntry>(KV.audit)).filter(
    (a) => a.details?.resource === "graph",
  );
}

describe("Graph Eviction", () => {
  beforeEach(() => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
  });
  afterEach(() => {
    delete process.env["GRAPH_EXTRACTION_ENABLED"];
    delete process.env["AGENTMEMORY_GRAPH_LEG"];
  });

  it("removes Entities and Relations whose only source is evicted, with every index", async () => {
    const kv = mockKV();
    await storeObservation(kv, "obs_live");
    await persistGraphDelta(
      kv as never,
      [node("a", ["obs_gone"]), node("b", ["obs_gone", "obs_live"]), node("c", ["obs_gone"])],
      [edge("e_ab", "a", "b", ["obs_gone"]), edge("e_bc", "b", "c", ["obs_live"])],
      [],
    );

    const counts = await evictGraphForSources(kv as never, ["obs_gone"], "mem::observe");

    expect(counts).toEqual({ nodes: 2, edges: 2 });
    expect(await kv.get(KV.graphNodes, "a")).toBeNull();
    expect(await kv.get(KV.graphNodes, "c")).toBeNull();
    expect(await kv.get(KV.graphNodes, "b")).not.toBeNull();
    expect(await kv.list(KV.graphEdges)).toEqual([]);
    expect(await kv.get(KV.graphEdgeKey, edgeIndexKey("a", "b", "imports"))).toBeNull();
    expect(await kv.get(KV.graphEdgeKey, edgeIndexKey("b", "c", "imports"))).toBeNull();
    for (const id of ["a", "b", "c"]) {
      expect(await kv.get(KV.graphAdjacency, id)).toBeNull();
    }
    expect(await kv.get(KV.graphNodeDegree, "a")).toBeNull();
    expect(await kv.get(KV.graphNodeDegree, "c")).toBeNull();
    expect(await kv.get(KV.graphNodeDegree, "b")).toBe(0);
    expect(await kv.get(KV.graphNameIndex, nameIndexKey("file", "src/a.ts"))).toBeNull();
    expect(await kv.get(KV.graphNameIndex, nameIndexKey("file", "src/b.ts"))).toBe("b");
    expect((await loadNameCatalog(kv as never)).map((e) => e.id)).toEqual(["b"]);
    expect(await kv.get(KV.graphObsNodes, "obs_gone")).toBeNull();
    expect(await kv.get(KV.graphObsNodes, "obs_live")).toEqual(["b"]);

    const snap = await snapshot(kv);
    expect(snap.stats.totalNodes).toBe(1);
    expect(snap.stats.nodesByType.file).toBe(1);
    expect(snap.stats.totalEdges).toBe(0);
    expect(snap.stats.edgesByType.imports).toBe(0);
    expect(snap.topNodes.map((n) => n.id)).toEqual(["b"]);
    expect(Object.keys(snap.topDegrees)).toEqual(["b"]);
    expect(snap.topDegrees.b).toBe(0);
    expect(snap.topEdges).toEqual([]);

    const [audit] = await graphAudits(kv);
    expect(audit.operation).toBe("delete");
    expect(audit.functionId).toBe("mem::observe");
    expect([...audit.targetIds].sort()).toEqual(["a", "c", "e_ab", "e_bc"]);
  });

  it("keeps an Entity another stored Observation still names", async () => {
    const kv = mockKV();
    await storeObservation(kv, "obs_live");
    await persistGraphDelta(kv as never, [node("shared", ["obs_gone", "obs_live"])], [], []);

    expect(await evictGraphForSources(kv as never, ["obs_gone"], "mem::evict")).toEqual({
      nodes: 0,
      edges: 0,
    });
    expect(await kv.get(KV.graphNodes, "shared")).not.toBeNull();
    expect(await graphAudits(kv)).toEqual([]);
  });

  it("keeps an Entity named by a stored Memory", async () => {
    const kv = mockKV();
    await kv.set(KV.memories, "mem_1", { id: "mem_1" });
    await persistGraphDelta(kv as never, [node("remembered", ["obs_gone", "mem_1"])], [], []);

    await evictGraphForSources(kv as never, ["obs_gone"], "mem::evict");

    expect(await kv.get(KV.graphNodes, "remembered")).not.toBeNull();
  });

  it("keeps an Entity whose Provenance is at the cap, since it may have dropped a live source", async () => {
    const kv = mockKV();
    const atCap = Array.from({ length: 50 }, (_, i) => `obs_gone_${i}`);
    await persistGraphDelta(kv as never, [node("busy", atCap)], [], []);

    await evictGraphForSources(kv as never, atCap, "mem::evict");

    expect(await kv.get(KV.graphNodes, "busy")).not.toBeNull();
  });

  it("keeps an Entity that gains a live source while eviction waits for the write lock", async () => {
    const kv = mockKV();
    await persistGraphDelta(kv as never, [node("a", ["obs_gone"])], [], []);

    let release!: () => void;
    const held = withKeyedLock(
      GRAPH_WRITE_LOCK,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const eviction = evictGraphForSources(kv as never, ["obs_gone"], "mem::evict");
    await new Promise((r) => setTimeout(r, 0));
    await storeObservation(kv, "obs_new");
    await kv.set(KV.graphNodes, "a", node("a", ["obs_gone", "obs_new"]));
    release();
    await held;

    expect(await eviction).toEqual({ nodes: 0, edges: 0 });
    expect(await kv.get<GraphNode>(KV.graphNodes, "a")).toMatchObject({
      sourceObservationIds: ["obs_gone", "obs_new"],
    });
  });

  it("leaves the graph alone but drops obs-node rows when the graph leg is off", async () => {
    const kv = mockKV();
    await persistGraphDelta(kv as never, [node("a", ["obs_gone"])], [], []);
    process.env["AGENTMEMORY_GRAPH_LEG"] = "off";

    await evictGraphForSources(kv as never, ["obs_gone"], "mem::evict");

    expect(await kv.get(KV.graphNodes, "a")).not.toBeNull();
    expect(await kv.get(KV.graphObsNodes, "obs_gone")).toBeNull();
  });

  describe("orphan sweep", () => {
    it("removes orphans no obs-node row points at and drops rows for gone sources", async () => {
      const kv = mockKV();
      await storeObservation(kv, "obs_live");
      await persistGraphDelta(
        kv as never,
        [node("orphan", ["obs_gone"]), node("kept", ["obs_live"])],
        [edge("e_k", "kept", "kept", ["obs_old"])],
        [],
      );
      await kv.delete(KV.graphObsNodes, "obs_gone");
      await kv.set(KV.graphObsNodes, "obs_stale", ["kept"]);

      const totals = await sweepOrphanedGraph(kv as never, "mem::evict");

      expect(totals).toEqual({ nodes: 1, edges: 1, obsLinks: 1 });
      expect(await kv.get(KV.graphNodes, "orphan")).toBeNull();
      expect(await kv.get(KV.graphNodes, "kept")).not.toBeNull();
      expect(await kv.get(KV.graphEdges, "e_k")).toBeNull();
      expect(await kv.get(KV.graphObsNodes, "obs_stale")).toBeNull();
      expect(await kv.get(KV.graphObsNodes, "obs_live")).toEqual(["kept"]);
      expect(await kv.get(KV.state, "system:graphOrphanSweep")).toBeNull();
      expect((await graphAudits(kv)).map((a) => a.details?.reason)).toEqual([
        "orphaned_provenance",
        "orphaned_provenance",
      ]);
    });

    it("resumes an interrupted pass from its saved cursor", async () => {
      const kv = mockKV();
      await persistGraphDelta(kv as never, [node("a", ["obs_gone"]), node("b", ["obs_gone"])], [], []);
      await kv.set(KV.state, "system:graphOrphanSweep", { phase: "nodes", after: "a" });

      expect((await sweepOrphanedGraph(kv as never, "mem::evict")).nodes).toBe(1);
      expect(await kv.get(KV.graphNodes, "a")).not.toBeNull();
      expect(await kv.get(KV.graphNodes, "b")).toBeNull();

      expect((await sweepOrphanedGraph(kv as never, "mem::evict")).nodes).toBe(1);
      expect(await kv.get(KV.graphNodes, "a")).toBeNull();
    });
  });
});
