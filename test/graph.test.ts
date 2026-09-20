import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import type {
  CompressedObservation,
  GraphNode,
  GraphEdge,
  GraphQueryResult,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const mockProvider = {
  name: "test",
  compress: vi.fn().mockResolvedValue(`<entities>
<entity type="file" name="src/index.ts"><property key="path">src/index.ts</property></entity>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`),
  summarize: vi.fn(),
};

// Structured fields stay empty so the deterministic heuristic pass
// contributes nothing and these tests keep exercising the LLM XML
// parse + persist path in isolation.
const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit index file",
  facts: ["Modified main function"],
  narrative: "Updated index.ts with main function",
  concepts: [],
  files: [],
  importance: 7,
};

describe("Graph Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const ORIG_GRAPH_FLAG = process.env["GRAPH_EXTRACTION_ENABLED"];

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  afterEach(() => {
    if (ORIG_GRAPH_FLAG === undefined) delete process.env["GRAPH_EXTRACTION_ENABLED"];
    else process.env["GRAPH_EXTRACTION_ENABLED"] = ORIG_GRAPH_FLAG;
  });

  it("graph-extract creates nodes and edges from XML response", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(2);
    expect(nodes.find((n) => n.name === "src/index.ts")).toBeDefined();
    expect(nodes.find((n) => n.name === "main")).toBeDefined();

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("uses");
  });

  it("graph-extract stamps nodes with the source observation's sessionId (#656)", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBeGreaterThan(0);
    // Every node built from testObs must carry its session so retrieval
    // can resolve KV.observations(sessionId) instead of the empty namespace.
    for (const n of nodes) {
      expect(n.sessionId).toBe("ses_1");
    }
  });

  it("graph-extract accepts self-closing entity tags", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file" name="src/index.ts"/>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`);

    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.some((n) => n.name === "src/index.ts")).toBe(true);
    expect(nodes.some((n) => n.name === "main")).toBe(true);

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");
  });

  it("graph-extract tolerates reordered attributes (#635)", async () => {
    // Codex CLI's LLM tends to emit attribute order name→type and
    // source→target→type rather than the hard-coded type-first /
    // type/source/target/weight sequence the old parser required.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity name="src/index.ts" type="file"/>
<entity name="main" type="function"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship source="src/index.ts" target="main" type="uses" weight="0.9"/>
</relationships>`);

    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.find((n) => n.name === "src/index.ts")?.type).toBe("file");
    expect(nodes.find((n) => n.name === "main")?.type).toBe("function");

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");
    expect(edges[0].weight).toBeCloseTo(0.9, 5);
  });

  it("graph-query with search returns matching nodes", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-query", {
      query: "index",
    })) as GraphQueryResult;

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes.some((n) => n.name.includes("index"))).toBe(true);
  });

  it("graph-query with startNodeId does BFS traversal", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });
    // Arm the read side-indexes so the startNodeId walk traverses via the
    // bounded adjacency index. Unarmed the reader is fail-closed (graph-read
    // -fix local delta 1) and serves the snapshot, not a BFS.
    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    const fileNode = nodes.find((n) => n.name === "src/index.ts")!;

    const result = (await sdk.trigger("mem::graph-query", {
      startNodeId: fileNode.id,
      maxDepth: 2,
    })) as GraphQueryResult;

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.depth).toBe(2);
  });

  it("graph-stats returns counts by type", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-stats", {})) as {
      totalNodes: number;
      totalEdges: number;
      nodesByType: Record<string, number>;
      edgesByType: Record<string, number>;
    };

    expect(result.totalNodes).toBe(2);
    expect(result.totalEdges).toBe(1);
    expect(result.nodesByType.file).toBe(1);
    expect(result.nodesByType.function).toBe(1);
    expect(result.edgesByType.uses).toBe(1);
  });

  it("graph-extract returns error for empty observations", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [],
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("No observations");
  });

  // #753: an unbounded {} body used to materialize every node+edge in
  // one payload, which exceeded the iii state response channel on
  // large corpora (11k+ nodes) and returned HTTP 500 "Invocation
  // stopped". The fix caps the page at DEFAULT_GRAPH_QUERY_LIMIT (500)
  // and surfaces totalNodes / totalEdges so callers know it was
  // truncated.
  it("caps an unbounded graph-query body to a default page and reports totals", async () => {
    // Seed a graph with more nodes than the default page size.
    const NODE_COUNT = 1200;
    for (let i = 0; i < NODE_COUNT; i++) {
      const node: GraphNode = {
        id: `n_${i.toString().padStart(4, "0")}`,
        type: "concept",
        name: `node-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      } as GraphNode;
      await kv.set("mem:graph:nodes", node.id, node);
    }
    // A few edges among the first 50 nodes so high-degree ranking has
    // something to grade.
    for (let i = 0; i < 50; i++) {
      const edge: GraphEdge = {
        id: `e_${i}`,
        type: "related_to",
        sourceNodeId: `n_${i.toString().padStart(4, "0")}`,
        targetNodeId: `n_${((i + 1) % 50).toString().padStart(4, "0")}`,
        weight: 1,
        evidence: [],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
      } as GraphEdge;
      await kv.set("mem:graph:edges", edge.id, edge);
    }

    // Post-#814 the empty-body path reads the snapshot exclusively.
    // Backfill the snapshot from the seeded data first.
    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const unbounded = (await sdk.trigger(
      "mem::graph-query",
      {},
    )) as GraphQueryResult;

    expect(unbounded.totalNodes).toBe(NODE_COUNT);
    expect(unbounded.nodes.length).toBe(500);
    expect(unbounded.truncated).toBe(true);
    expect(unbounded.limit).toBe(500);
    expect(unbounded.offset).toBe(0);
    // The 50 connected nodes should be on the first page since the
    // default ranks by degree.
    const connectedOnPage = unbounded.nodes.filter((n) => /^n_00[0-4]\d$/.test(n.id));
    expect(connectedOnPage.length).toBe(50);
  });

  it("honors limit and offset for paged graph-query traversal", async () => {
    for (let i = 0; i < 50; i++) {
      const node: GraphNode = {
        id: `p_${i.toString().padStart(3, "0")}`,
        type: "concept",
        name: `node-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      } as GraphNode;
      await kv.set("mem:graph:nodes", node.id, node);
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const page1 = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 0,
    })) as GraphQueryResult;
    const page2 = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 10,
    })) as GraphQueryResult;

    expect(page1.nodes.length).toBe(10);
    expect(page2.nodes.length).toBe(10);
    expect(page1.totalNodes).toBe(50);
    expect(page2.totalNodes).toBe(50);
    expect(page1.truncated).toBe(true);
    // The two pages must not overlap.
    const overlap = page1.nodes.filter((n) =>
      page2.nodes.some((p) => p.id === n.id),
    );
    expect(overlap.length).toBe(0);
  });

  it("clamps an explicit limit above the cap to the cap value", async () => {
    for (let i = 0; i < 10; i++) {
      await kv.set("mem:graph:nodes", `c_${i}`, {
        id: `c_${i}`,
        type: "concept",
        name: `n-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      });
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const huge = (await sdk.trigger("mem::graph-query", {
      limit: 999999,
    })) as GraphQueryResult;
    expect(huge.limit).toBeLessThanOrEqual(5000);
    expect(huge.nodes.length).toBe(10);
    expect(huge.truncated).toBe(false);
  });

  it("paginate excludes edges whose endpoints fall outside the page", async () => {
    for (let i = 0; i < 60; i++) {
      await kv.set("mem:graph:nodes", `x_${i.toString().padStart(3, "0")}`, {
        id: `x_${i.toString().padStart(3, "0")}`,
        type: "concept",
        name: `n-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      });
    }
    // Make the first 10 nodes a tightly connected cluster so they
    // rank highest by degree and land on the page deterministically.
    for (let i = 0; i < 10; i++) {
      const next = (i + 1) % 10;
      await kv.set("mem:graph:edges", `cluster_${i}`, {
        id: `cluster_${i}`,
        type: "related_to",
        sourceNodeId: `x_${i.toString().padStart(3, "0")}`,
        targetNodeId: `x_${next.toString().padStart(3, "0")}`,
        weight: 1,
        evidence: [],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
      });
    }
    // Cross-page edge: source in the high-degree cluster (on page),
    // target is an isolated node (degree 1; cluster nodes have
    // degree 2 so the target ranks below the cap).
    await kv.set("mem:graph:edges", "cross", {
      id: "cross",
      type: "related_to",
      sourceNodeId: "x_005",
      targetNodeId: "x_055",
      weight: 1,
      evidence: [],
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-01T00:00:00Z",
    });

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const page = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 0,
    })) as GraphQueryResult;
    // The cross-page edge should not appear in the page response —
    // otherwise the viewer renders a dangling line to a node it
    // doesn't have.
    expect(page.edges.find((e) => e.id === "cross")).toBeUndefined();
    // Cluster edges among page nodes ARE present.
    expect(page.edges.filter((e) => e.id.startsWith("cluster_")).length).toBe(10);
    // totalEdges counts every edge in the full result universe.
    expect(page.totalEdges).toBe(11);
  });

  // #814: precomputed snapshot path. The viewer-tab default-cap query
  // and graph-stats both have to work at 75K-node scale where the
  // full kv.list enumeration exceeds the iii invocation budget.
  describe("snapshot cache (#814)", () => {
    async function seed(nodeCount: number, edgeCount: number) {
      for (let i = 0; i < nodeCount; i++) {
        await kv.set("mem:graph:nodes", `n_${i}`, {
          id: `n_${i}`,
          type: i % 3 === 0 ? "file" : "function",
          name: `node-${i}`,
          properties: {},
          sourceObservationIds: [`obs_${i}`],
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          observationCount: 1,
          stale: false,
        });
      }
      for (let i = 0; i < edgeCount; i++) {
        const src = `n_${i % nodeCount}`;
        const dst = `n_${(i + 1) % nodeCount}`;
        await kv.set("mem:graph:edges", `e_${i}`, {
          id: `e_${i}`,
          type: i % 2 === 0 ? "uses" : "imports",
          sourceNodeId: src,
          targetNodeId: dst,
          weight: 1,
          evidence: [],
          sourceObservationIds: [`obs_${i}`],
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          stale: false,
        });
      }
    }

    it("snapshot-rebuild persists top-degree subgraph + aggregate stats", async () => {
      await seed(50, 100);
      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", { force: true })) as {
        success: boolean;
        totalNodes: number;
        totalEdges: number;
        topNodes: number;
        topEdges: number;
      };
      expect(result.success).toBe(true);
      expect(result.totalNodes).toBe(50);
      expect(result.totalEdges).toBe(100);
      // 50 nodes is below the SNAPSHOT_TOP_NODES cap, so every node
      // lands in the snapshot.
      expect(result.topNodes).toBe(50);

      const snap = await kv.get<{
        version: number;
        topNodes: unknown[];
        stats: { totalNodes: number; nodesByType: Record<string, number> };
      }>("mem:graph:snapshot", "current");
      expect(snap).not.toBeNull();
      expect(snap!.version).toBe(1);
      expect(snap!.stats.totalNodes).toBe(50);
      // nodesByType reflects every type seen.
      expect(snap!.stats.nodesByType["file"]).toBeGreaterThan(0);
      expect(snap!.stats.nodesByType["function"]).toBeGreaterThan(0);
    });

    it("graph-query empty-body branch serves from snapshot once it exists", async () => {
      await seed(20, 30);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const result = (await sdk.trigger("mem::graph-query", {})) as GraphQueryResult;
      expect(result.fromSnapshot).toBe(true);
      expect(result.totalNodes).toBe(20);
      expect(result.totalEdges).toBe(30);
    });

    it("graph-query nodeType filter respects snapshot type counts", async () => {
      await seed(30, 0);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const fileQuery = (await sdk.trigger("mem::graph-query", {
        nodeType: "file",
      })) as GraphQueryResult;
      expect(fileQuery.fromSnapshot).toBe(true);
      // 30 nodes, every 3rd is "file" → 10 files.
      expect(fileQuery.totalNodes).toBe(10);
      for (const n of fileQuery.nodes) {
        expect(n.type).toBe("file");
      }
    });

    it("graph-stats returns from snapshot when not dirty", async () => {
      await seed(15, 25);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const stats = (await sdk.trigger("mem::graph-stats", {})) as {
        totalNodes: number;
        totalEdges: number;
        fromSnapshot: boolean;
      };
      expect(stats.fromSnapshot).toBe(true);
      expect(stats.totalNodes).toBe(15);
      expect(stats.totalEdges).toBe(25);
    });

    it("graph-extract updates snapshot inline (no kv.list, dirty stays false)", async () => {
      // Post-#814 v2 the snapshot is updated incrementally on every
      // extract — no dirty flag bounces. Test asserts that after an
      // extract the snapshot reflects the new nodes/edges.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });

      const snap = await kv.get<{
        dirty: boolean;
        stats: { totalNodes: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.dirty).toBe(false);
      // testObs produces 2 nodes (src/index.ts, main) + 1 edge.
      expect(snap?.stats.totalNodes).toBeGreaterThanOrEqual(1);
    });

    it("graph-extract maintains name-index for O(1) dedup on re-extract", async () => {
      // First extract creates nodes.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const nameIndex = await kv.get<string>(
        "mem:graph:name-index",
        "file|src/index.ts",
      );
      expect(typeof nameIndex).toBe("string");

      // Re-extract the same observation. With name-index lookup the
      // existing node merges; no duplicates.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const nodes = await kv.list<{ name: string; type: string }>(
        "mem:graph:nodes",
      );
      const fileNodes = nodes.filter(
        (n) => n.name === "src/index.ts" && n.type === "file",
      );
      expect(fileNodes.length).toBe(1);
    });

    it("graph-stats returns empty envelope + warning when no snapshot exists", async () => {
      // Seed nodes but never rebuild the snapshot — simulates a legacy
      // corpus on a post-#814 upgrade.
      await seed(5, 5);

      const stats = (await sdk.trigger("mem::graph-stats", {})) as {
        totalNodes: number;
        totalEdges: number;
        fromSnapshot: boolean;
        warning?: string;
      };
      expect(stats.fromSnapshot).toBe(false);
      expect(stats.totalNodes).toBe(0);
      expect(stats.warning).toMatch(/snapshot-rebuild|graph\/reset/);
    });

    it("graph-reset clears state and writes empty snapshot", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const result = (await sdk.trigger("mem::graph-reset", {})) as {
        success: boolean;
        cleared: Record<string, number>;
      };
      expect(result.success).toBe(true);

      const snap = await kv.get<{
        stats: { totalNodes: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.stats.totalNodes).toBe(0);
    });

    it("graph-reset writes empty snapshot; legacy rows stay as orphans (#825)", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      // Index entries exist after the extract.
      const nameBefore = await kv.get(
        "mem:graph:name-index",
        "file|src/index.ts",
      );
      expect(nameBefore).not.toBeNull();

      await sdk.trigger("mem::graph-reset", {});

      // Post-#825: reset is enumeration-free. It writes an empty
      // snapshot; the legacy index rows remain on disk as orphans
      // but are never read by any post-#816 code path (hot path
      // reads only the snapshot, which is now empty). Asserting the
      // visible behavior: snapshot empty, hot path returns empty.
      const snap = await kv.get<{
        stats: { totalNodes: number; totalEdges: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.stats.totalNodes).toBe(0);
      expect(snap?.stats.totalEdges).toBe(0);
    });
  });

  // CodeRabbit feedback: cover the rebuild refusal + degradation paths.
  // Post graph-read-fix (local delta 1) the BFS / query branches no longer
  // enumerate at all — they fail closed to a snapshot/unavailable envelope
  // — so only the rebuild endpoint still calls kv.list. Both keep explicit
  // failure-mode tests.
  describe("budget + tooLarge guards (#814 v2)", () => {
    function slowKV(delayMs: number) {
      const base = mockKV();
      return {
        ...base,
        list: async <T>(scope: string): Promise<T[]> => {
          await new Promise((r) => setTimeout(r, delayMs));
          return base.list<T>(scope);
        },
      };
    }

    it("graph-query startNodeId returns a degradation warning when unarmed (fail-closed)", async () => {
      // graph-read-fix local delta 1: the unarmed query/startNodeId path no
      // longer enumerates (that kv.list was the pre-#814 500). It fails
      // closed to a snapshot-backed / unavailable envelope. slowKV's delay
      // is never reached because no graph-scope list is issued.
      const slow = slowKV(7000);
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, slow as never, mockProvider as never);

      const result = (await localSdk.trigger("mem::graph-query", {
        startNodeId: "n_missing",
      })) as GraphQueryResult;

      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/unavailable|unarmed|snapshot|leg|walk/i);
      expect(result.nodes).toEqual([]);
    }, 10000);

    // CodeRabbit raised that slowKV(setTimeout) doesn't simulate a
    // blocked event loop. The real production failure is iii rejecting
    // the trigger with "Invocation stopped" after the worker dies
    // (heartbeat starvation). A rejecting kv.list mock covers that
    // catch-path directly without introducing a busy-wait that would
    // also starve the budget timer and produce a flaky test.
    function rejectingKV() {
      const base = mockKV();
      return {
        ...base,
        list: async <T>(_scope: string): Promise<T[]> => {
          throw new Error("Invocation stopped");
        },
      };
    }

    it("graph-query rejects-from-engine path returns warning envelope (worker-death simulation)", async () => {
      const rejector = rejectingKV();
      const localSdk = mockSdk();
      registerGraphFunction(
        localSdk as never,
        rejector as never,
        mockProvider as never,
      );

      const result = (await localSdk.trigger("mem::graph-query", {
        startNodeId: "n_missing",
      })) as GraphQueryResult;

      expect(result.warning).toBeTruthy();
      expect(result.nodes).toEqual([]);
    });

    it("graph-snapshot-rebuild refuses corpora past REBUILD_SAFE_NODE_CEILING", async () => {
      // Direct-poke the mock store with > 25K node values so kv.list
      // returns them without paying the per-set cost. Each node only
      // needs id/type/name/stale=false for the rebuild path.
      const localKv = mockKV();
      // Walk the implementation detail: mockKV stores entries in a
      // Map under the scope key. Push directly to that map via the
      // public `set` API in a tight loop.
      const COUNT = 25001;
      const sets: Array<Promise<unknown>> = [];
      for (let i = 0; i < COUNT; i++) {
        sets.push(
          localKv.set("mem:graph:nodes", `bn_${i}`, {
            id: `bn_${i}`,
            type: "concept",
            name: `bulk-${i}`,
            properties: {},
            sourceObservationIds: [],
            createdAt: "2026-01-01T00:00:00Z",
            stale: false,
          }),
        );
      }
      await Promise.all(sets);

      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger(
        "mem::graph-snapshot-rebuild",
        { force: true },
      )) as { success: boolean; tooLarge?: boolean; totalNodes?: number };
      expect(result.success).toBe(false);
      expect(result.tooLarge).toBe(true);
      expect(result.totalNodes).toBeGreaterThanOrEqual(25001);
    });

    // #825: new pre-flight refusal when no snapshot exists (signals
    // legacy corpus that would crash on kv.list). force=true bypasses.
    it("graph-snapshot-rebuild refuses on legacy corpus (no snapshot) without force", async () => {
      const localKv = mockKV();
      // Seed nodes but never persist a snapshot → simulates a corpus
      // built on a pre-#814 agentmemory.
      await localKv.set("mem:graph:nodes", "legacy_n", {
        id: "legacy_n",
        type: "concept",
        name: "legacy",
        properties: {},
        sourceObservationIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        stale: false,
      });
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger(
        "mem::graph-snapshot-rebuild",
        {},
      )) as { success: boolean; legacyCorpus?: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.legacyCorpus).toBe(true);
      expect(result.error).toMatch(/graph\/reset|force/);
    });

    it("graph-reset is enumeration-free (does not call kv.list)", async () => {
      // Wrap the mock kv.list with a counter; assert it stays at 0
      // across a full reset cycle.
      const localKv = mockKV();
      let listCalls = 0;
      const baseList = localKv.list;
      localKv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(localKv, scope) as Promise<T[]>;
      };
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger("mem::graph-reset", {})) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(listCalls).toBe(0);
    });
  });
  // #1168: provenance on a node or edge grew with every mention. It is
  // evidence of origin, not a complete history, so it is capped and the
  // newest ids are the ones worth keeping.
  describe("bounded provenance (#1168)", () => {
    const ORIG_CAP = process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];

    afterEach(() => {
      if (ORIG_CAP === undefined) delete process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];
      else process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = ORIG_CAP;
    });

    const extract = async (obsId: string): Promise<void> => {
      await sdk.trigger("mem::graph-extract", {
        observations: [{ ...testObs, id: obsId }],
      });
    };

    it("keeps only the newest ids on a node mentioned more often than the cap", async () => {
      process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = "3";
      for (const id of ["obs_1", "obs_2", "obs_3", "obs_4", "obs_5"]) await extract(id);

      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      for (const node of nodes) {
        expect(node.sourceObservationIds).toEqual(["obs_3", "obs_4", "obs_5"]);
      }
    });

    it("keeps only the newest ids on an edge mentioned more often than the cap", async () => {
      process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = "3";
      for (const id of ["obs_1", "obs_2", "obs_3", "obs_4", "obs_5"]) await extract(id);

      const edges = await kv.list<GraphEdge>("mem:graph:edges");
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.sourceObservationIds).toEqual(["obs_3", "obs_4", "obs_5"]);
      }
    });

    it("bounds a first write whose batch is larger than the cap", async () => {
      process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = "2";
      await sdk.trigger("mem::graph-extract", {
        observations: ["obs_1", "obs_2", "obs_3", "obs_4"].map((id) => ({
          ...testObs,
          id,
        })),
      });

      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.sourceObservationIds).toEqual(["obs_3", "obs_4"]);
      }
    });

    it("leaves a node under the cap untouched", async () => {
      process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = "10";
      for (const id of ["obs_1", "obs_2"]) await extract(id);

      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      for (const node of nodes) {
        expect(node.sourceObservationIds).toEqual(["obs_1", "obs_2"]);
      }
    });

    it("caps at 50 when no override is set", async () => {
      delete process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];
      await sdk.trigger("mem::graph-extract", {
        observations: Array.from({ length: 60 }, (_, i) => ({
          ...testObs,
          id: `obs_${i + 1}`,
        })),
      });

      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.sourceObservationIds.length).toBe(50);
        expect(node.sourceObservationIds.at(-1)).toBe("obs_60");
        expect(node.sourceObservationIds[0]).toBe("obs_11");
      }
    });
  });
  // #1169: a Graph Snapshot read failure used to be swallowed, and extraction
  // then wrote its empty view back over the real Snapshot. Absence is not
  // failure: a first run still proceeds on an empty graph.
  describe("snapshot read failure aborts extraction (#1169)", () => {
    const storedSnapshot = {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 7,
        totalEdges: 3,
        nodesByType: { file: 7 },
        edgesByType: { uses: 3 },
      },
      updatedAt: "2026-01-01T00:00:00Z",
      dirty: false,
    };

    const failingKv = () => {
      const base = mockKV();
      return {
        ...base,
        get: async <T,>(scope: string, key: string): Promise<T | null> => {
          if (scope === "mem:graph:snapshot") {
            throw new Error("state store unavailable");
          }
          return base.get<T>(scope, key);
        },
        set: base.set,
      };
    };

    it("performs no writes when the snapshot cannot be read", async () => {
      const kvLocal = failingKv();
      await kvLocal.set("mem:graph:snapshot", "current", storedSnapshot);
      const sdkLocal = mockSdk();
      registerGraphFunction(sdkLocal as never, kvLocal as never, mockProvider as never);

      await sdkLocal.trigger("mem::graph-extract", { observations: [testObs] });

      expect(await kvLocal.list<GraphNode>("mem:graph:nodes")).toEqual([]);
      expect(await kvLocal.list<GraphEdge>("mem:graph:edges")).toEqual([]);
    });

    it("leaves the stored snapshot and its statistics unchanged", async () => {
      const kvLocal = failingKv();
      await kvLocal.set("mem:graph:snapshot", "current", storedSnapshot);
      const sdkLocal = mockSdk();
      registerGraphFunction(sdkLocal as never, kvLocal as never, mockProvider as never);

      await sdkLocal.trigger("mem::graph-extract", { observations: [testObs] });

      const [stored] = await kvLocal.list<typeof storedSnapshot>("mem:graph:snapshot");
      expect(stored).toEqual(storedSnapshot);
    });

    it("logs the abort at warning level, naming the snapshot read", async () => {
      const kvLocal = failingKv();
      const sdkLocal = mockSdk();
      registerGraphFunction(sdkLocal as never, kvLocal as never, mockProvider as never);

      await sdkLocal.trigger("mem::graph-extract", { observations: [testObs] });

      const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((m) => /snapshot read/i.test(m))).toBe(true);
    });

    it("treats a genuinely absent snapshot as an empty graph and proceeds", async () => {
      const result = (await sdk.trigger("mem::graph-extract", {
        observations: [testObs],
      })) as { success: boolean; nodesAdded: number };

      expect(result.success).toBe(true);
      expect(result.nodesAdded).toBe(2);
    });

    it("proceeds normally on the next batch once the read recovers", async () => {
      let failing = true;
      const base = mockKV();
      const kvLocal = {
        ...base,
        get: async <T,>(scope: string, key: string): Promise<T | null> => {
          if (failing && scope === "mem:graph:snapshot") {
            throw new Error("state store unavailable");
          }
          return base.get<T>(scope, key);
        },
        set: base.set,
      };
      await kvLocal.set("mem:graph:snapshot", "current", storedSnapshot);
      const sdkLocal = mockSdk();
      registerGraphFunction(sdkLocal as never, kvLocal as never, mockProvider as never);

      await sdkLocal.trigger("mem::graph-extract", { observations: [testObs] });
      expect(await kvLocal.list<GraphNode>("mem:graph:nodes")).toEqual([]);

      failing = false;
      const result = (await sdkLocal.trigger("mem::graph-extract", {
        observations: [{ ...testObs, id: "obs_2" }],
      })) as { success: boolean; nodesAdded: number };

      expect(result.success).toBe(true);
      expect((await kvLocal.list<GraphNode>("mem:graph:nodes")).length).toBe(2);
    });
  });
  // #1171: the Graph Snapshot exists to make reads cheap by holding a bounded
  // view of the busiest entities. Carrying Provenance along with them made it
  // grow with how often things are mentioned, which is the opposite of that.
  // Provenance stays on the records themselves.
  describe("snapshot carries no provenance (#1171)", () => {
    it("drops provenance from snapshot entities and relations on rebuild", async () => {
      await kv.set("mem:graph:nodes", "n_0", {
        id: "n_0", type: "file", name: "a", properties: {},
        sourceObservationIds: ["obs_1", "obs_2"], stale: false,
      });
      await kv.set("mem:graph:nodes", "n_1", {
        id: "n_1", type: "file", name: "b", properties: {},
        sourceObservationIds: ["obs_1"], stale: false,
      });
      await kv.set("mem:graph:edges", "e_0", {
        id: "e_0", type: "uses", sourceNodeId: "n_0", targetNodeId: "n_1",
        weight: 1, sourceObservationIds: ["obs_1", "obs_2"], stale: false,
      });

      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const [snapshot] = await kv.list<Record<string, unknown>>("mem:graph:snapshot");
      for (const entry of [
        ...(snapshot["topNodes"] as Record<string, unknown>[]),
        ...(snapshot["topEdges"] as Record<string, unknown>[]),
      ]) {
        expect(entry).not.toHaveProperty("sourceObservationIds");
      }
      expect((snapshot["topNodes"] as unknown[]).length).toBe(2);
      expect((snapshot["topEdges"] as unknown[]).length).toBe(1);
    });

    it("drops provenance from entries the extract path writes into the snapshot", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });

      const [snapshot] = await kv.list<Record<string, unknown>>("mem:graph:snapshot");
      const entries = [
        ...(snapshot["topNodes"] as Record<string, unknown>[]),
        ...(snapshot["topEdges"] as Record<string, unknown>[]),
      ];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry).not.toHaveProperty("sourceObservationIds");
      }
    });

    it("leaves provenance on the entity and relation records themselves", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });

      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      const edges = await kv.list<GraphEdge>("mem:graph:edges");
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) expect(node.sourceObservationIds).toEqual(["obs_1"]);
      for (const edge of edges) expect(edge.sourceObservationIds).toEqual(["obs_1"]);
    });

    it("keeps the same entities, relations and statistics it carried before", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });

      const [snapshot] = await kv.list<Record<string, unknown>>("mem:graph:snapshot");
      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      const topNodeIds = (snapshot["topNodes"] as { id: string }[]).map((n) => n.id);
      expect(new Set(topNodeIds)).toEqual(new Set(nodes.map((n) => n.id)));
      expect((snapshot["stats"] as { totalNodes: number }).totalNodes).toBe(nodes.length);
    });

    it("reads a snapshot written before this change and replaces it on the next write", async () => {
      await kv.set("mem:graph:snapshot", "current", {
        version: 1,
        topNodes: [
          { id: "n_old", type: "file", name: "old", properties: {},
            sourceObservationIds: ["obs_old"], stale: false },
        ],
        topEdges: [],
        topDegrees: { n_old: 0 },
        stats: { totalNodes: 1, totalEdges: 0, nodesByType: { file: 1 }, edgesByType: {} },
        updatedAt: "2026-01-01T00:00:00Z",
        dirty: false,
      });

      const result = (await sdk.trigger("mem::graph-extract", {
        observations: [testObs],
      })) as { success: boolean };
      expect(result.success).toBe(true);

      const [snapshot] = await kv.list<Record<string, unknown>>("mem:graph:snapshot");
      for (const entry of snapshot["topNodes"] as Record<string, unknown>[]) {
        expect(entry).not.toHaveProperty("sourceObservationIds");
      }
    });
  });
});
