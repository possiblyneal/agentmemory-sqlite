import { describe, it, expect } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import {
  backfillGraphIndexes,
  indexGraphEdge,
  indexGraphNode,
  readBoundedGraphSnapshot,
} from "../src/state/graph-indexes.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode } from "../src/types.js";

function storeBackedKV() {
  const store = new Map<string, Map<string, unknown>>();
  const reads = new Map<string, number>();
  const sdk = {
    trigger: async (input: {
      function_id: string;
      payload: { scope: string; key: string; value?: unknown };
    }) => {
      const { scope, key, value } = input.payload;
      if (input.function_id === "state::get") {
        reads.set(scope, (reads.get(scope) ?? 0) + 1);
        return store.get(scope)?.get(key) ?? null;
      }
      if (input.function_id === "state::set") {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, value);
        return value;
      }
      throw new Error(`unexpected ${input.function_id}`);
    },
  };
  return { kv: new StateKV(sdk as never), reads };
}

function node(id: string, name: string, obsId: string): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [obsId],
    createdAt: new Date().toISOString(),
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 0.8,
    sourceObservationIds: [],
    createdAt: new Date().toISOString(),
    isLatest: true,
  };
}

async function seed(kv: StateKV, nodes: GraphNode[], edges: GraphEdge[]) {
  for (const n of nodes) await kv.set(KV.graphNodes, n.id, n);
  for (const e of edges) await kv.set(KV.graphEdges, e.id, e);
  await backfillGraphIndexes(kv, nodes, edges);
}

describe("graph read view", () => {
  it("loads the name catalog once across searches", async () => {
    const { kv, reads } = storeBackedKV();
    await seed(kv, [node("n1", "react", "obs_1")], []);
    const retrieval = new GraphRetrieval(kv);

    await retrieval.searchByEntities(["react"]);
    reads.clear();
    await retrieval.searchByEntities(["react"]);

    expect(reads.get(KV.graphNameShards) ?? 0).toBe(0);
  });

  it("sees a node written after an earlier search", async () => {
    const { kv } = storeBackedKV();
    await seed(kv, [node("n1", "react", "obs_1")], []);
    const retrieval = new GraphRetrieval(kv);
    await retrieval.searchByEntities(["vue"]);

    const vue = node("n2", "vue", "obs_2");
    await kv.set(KV.graphNodes, vue.id, vue);
    await indexGraphNode(kv, vue);

    const results = await retrieval.searchByEntities(["vue"]);
    expect(results.map((r) => r.obsId)).toContain("obs_2");
  });

  it("sees a node marked stale after an earlier search", async () => {
    const { kv } = storeBackedKV();
    const react = node("n1", "react", "obs_1");
    await seed(kv, [react], []);
    const retrieval = new GraphRetrieval(kv);
    expect((await retrieval.searchByEntities(["react"])).length).toBeGreaterThan(0);

    await kv.set(KV.graphNodes, react.id, { ...react, stale: true });

    expect(await retrieval.searchByEntities(["react"])).toEqual([]);
  });

  it("stops a traversal after a bounded number of expanded nodes", async () => {
    const { kv } = storeBackedKV();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 800; i++) {
      nodes.push(node(`n${i}`, i === 0 ? "start" : `chain${i}`, `obs_${i}`));
      if (i > 0) edges.push(edge(`e${i}`, `n${i - 1}`, `n${i}`));
    }
    await seed(kv, nodes, edges);

    const results = await new GraphRetrieval(kv).searchByEntities(["start"], 1000, 1000);

    expect(results.length).toBeGreaterThan(100);
    expect(results.length).toBeLessThan(800);
  });
});

describe("readBoundedGraphSnapshot", () => {
  it("reads at most the node limit and the edges incident to those nodes", async () => {
    const { kv } = storeBackedKV();
    const nodes = ["a", "b", "c"].map((n) => node(`node_${n}`, n, `obs_${n}`));
    const edges = [edge("e1", "node_a", "node_b"), edge("e2", "node_b", "node_c")];
    for (const n of nodes) await kv.set(KV.graphNodes, n.id, n);
    for (const e of edges) await kv.set(KV.graphEdges, e.id, e);
    await backfillGraphIndexes(kv, nodes, edges);

    const snap = await readBoundedGraphSnapshot(kv, 1);

    expect(snap.nodes.map((n) => n.id)).toEqual(["node_a"]);
    expect(snap.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("is empty while the indexes are not armed", async () => {
    const { kv } = storeBackedKV();
    const n = node("n1", "x", "obs_1");
    await kv.set(KV.graphNodes, n.id, n);
    await indexGraphNode(kv, n);
    await indexGraphEdge(kv, edge("e1", "n1", "n1"));

    expect(await readBoundedGraphSnapshot(kv, 10)).toEqual({ nodes: [], edges: [] });
  });
});
