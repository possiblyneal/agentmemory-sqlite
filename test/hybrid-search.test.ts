import { describe, it, expect, beforeEach, vi } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { backfillGraphIndexes } from "../src/state/graph-indexes.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

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

describe("HybridSearch", () => {
  let bm25: SearchIndex;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    bm25 = new SearchIndex();
    kv = mockKV();
  });

  it("expands once and embeds each query once per prepared search", async () => {
    const embed = vi.fn(async (_text: string) => new Float32Array([1]));
    const vector = { size: 1, search: vi.fn(async () => []) };
    const provider: EmbeddingProvider = { name: "test", dimensions: 1, embed, embedBatch: async () => [] };
    const expand = vi.fn(async () => ({
      original: "query",
      reformulations: ["reformulated"],
      temporalConcretizations: [],
      entityExtractions: [],
    }));
    const hybrid = new HybridSearch(bm25, vector as never, provider, kv as never, 0.4, 0.6, 0, false);
    const search = hybrid.prepareSearch("query", expand);

    await search(100);
    await search(400);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls).toEqual([["query"], ["reformulated"]]);
    expect(vector.search).toHaveBeenCalledTimes(4);

    await hybrid.prepareSearch("query", expand)(100);
    expect(expand).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenCalledTimes(4);
  });

  it("retrieves an eligible vector behind a crowded out-of-range pool", async () => {
    const vector = new VectorIndex();
    const provider: EmbeddingProvider = { name: "test", dimensions: 2, embed: async () => new Float32Array([1, 0]), embedBatch: async () => [] };
    for (let i = 0; i < 101; i++) {
      const obs = makeObs({ id: `outside_${i}`, timestamp: "2026-02-01T00:00:00Z" });
      bm25.add(obs);
      vector.add(obs.id, obs.sessionId, new Float32Array([1, 0]));
      await kv.set("mem:obs:ses_1", obs.id, obs);
    }
    const inside = makeObs({ id: "inside", timestamp: "2026-01-01T00:00:00Z" });
    bm25.add(inside);
    vector.add(inside.id, inside.sessionId, new Float32Array([0.8, 0.2]));
    await kv.set("mem:obs:ses_1", inside.id, inside);
    const hybrid = new HybridSearch(bm25, vector, provider, kv as never, 0.4, 0.6, 0, false);
    const results = await hybrid.prepareSearch("auth", undefined, { after: Date.parse("2026-01-01T00:00:00Z"), before: Date.parse("2026-02-01T00:00:00Z") })(1);
    expect(results.map((r) => r.observation.id)).toEqual(["inside"]);
    expect(results[0].vectorScore).toBeGreaterThan(0);
  });

  it("does not let a stale vector Session exclude a valid bounded graph hit", async () => {
    const store = new InMemoryKV();
    const obs = makeObs({ id: "obs_graph", sessionId: "right", timestamp: "2026-01-15T00:00:00Z" });
    await store.set(KV.observations(obs.sessionId), obs.id, obs);
    const node = { id: "n1", name: "src/file.ts", type: "file" as const, properties: {}, sourceObservationIds: [obs.id], sessionId: obs.sessionId, createdAt: "2026-01-01T00:00:00Z" };
    await store.set(KV.graphNodes, node.id, node);
    await backfillGraphIndexes(store as never, [node], []);
    const vector = new VectorIndex();
    vector.add(obs.id, "stale", new Float32Array([1]));
    const provider: EmbeddingProvider = { name: "test", dimensions: 1, embed: async () => new Float32Array([1]), embedBatch: async () => [] };
    const hybrid = new HybridSearch(bm25, vector, provider, store as never);
    const expand = async () => ({ original: "query", reformulations: [], temporalConcretizations: [], entityExtractions: [node.name] });
    const search = hybrid.prepareSearch("query", expand, { after: Date.parse("2026-01-01T00:00:00Z") });
    expect((await search(1)).map(r => r.observation.id)).toEqual([obs.id]);
  });

  it("keeps an in-range vector hit when its Observation is absent from BM25", async () => {
    const obs = makeObs({ timestamp: "2026-01-15T00:00:00Z" });
    await kv.set("mem:obs:ses_1", obs.id, obs);
    const vector = new VectorIndex();
    vector.add(obs.id, obs.sessionId, new Float32Array([1, 0]));
    const provider: EmbeddingProvider = { name: "test", dimensions: 2, embed: async () => new Float32Array([1, 0]), embedBatch: async () => [] };
    const hybrid = new HybridSearch(bm25, vector, provider, kv as never, 0.4, 0.6, 0, false);
    const results = await hybrid.prepareSearch("auth", undefined, { after: Date.parse("2026-01-01T00:00:00Z"), before: Date.parse("2026-02-01T00:00:00Z") })(1);
    expect(results.map((r) => r.observation.id)).toEqual([obs.id]);
  });

  it("keeps healthy bounded vector hits when another candidate cannot be read", async () => {
    const obs = makeObs({ timestamp: "2026-01-15T00:00:00Z" });
    await kv.set("mem:obs:ses_1", obs.id, obs);
    const get = kv.get;
    kv.get = async (scope, id) => {
      if (id === "broken") throw new Error("bad row");
      return get(scope, id);
    };
    const vector = new VectorIndex();
    vector.add("broken", obs.sessionId, new Float32Array([1, 0]));
    vector.add(obs.id, obs.sessionId, new Float32Array([1, 0]));
    const provider: EmbeddingProvider = { name: "test", dimensions: 2, embed: async () => new Float32Array([1, 0]), embedBatch: async () => [] };
    const hybrid = new HybridSearch(bm25, vector, provider, kv as never, 0.4, 0.6, 0, false);
    expect((await hybrid.prepareSearch("auth", undefined, { after: Date.parse("2026-01-01T00:00:00Z") })(1)).map(r => r.observation.id)).toEqual([obs.id]);
  });

  it("rechecks the reloaded row after bounded candidate selection", async () => {
    const obs = makeObs({ timestamp: "2026-01-15T00:00:00Z" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", obs.id, { ...obs, timestamp: "2026-02-01T00:00:00Z" });
    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    expect(await hybrid.prepareSearch("auth", undefined, { before: Date.parse("2026-02-01T00:00:00Z") })(1)).toEqual([]);
    expect((await hybrid.prepareSearch("auth")(1)).map(r => r.observation.id)).toEqual([obs.id]);
  });

  it("returns BM25-only results when no vector index is provided", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it("returns empty results for no-match query", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("database");
    expect(results).toEqual([]);
  });

  it("combinedScore is derived from bm25Score when no vector index", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results[0].combinedScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].graphScore).toBe(0);
  });

  it("results are sorted by combinedScore descending", async () => {
    const obs1 = makeObs({
      id: "obs_1",
      sessionId: "ses_1",
      title: "auth handler",
      narrative: "auth auth auth module",
      concepts: ["auth"],
    });
    const obs2 = makeObs({
      id: "obs_2",
      sessionId: "ses_1",
      title: "database setup",
      narrative: "auth connection config",
      concepts: ["database"],
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(2);
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(
      results[1].combinedScore,
    );
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const obs = makeObs({
        id: `obs_${i}`,
        sessionId: "ses_1",
        title: `auth feature ${i}`,
      });
      bm25.add(obs);
      await kv.set("mem:obs:ses_1", `obs_${i}`, obs);
    }

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 3);
    expect(results.length).toBe(3);
  });

  it("skips observations not found in KV", async () => {
    const obs = makeObs({ id: "obs_missing", sessionId: "ses_1" });
    bm25.add(obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");
    expect(results).toEqual([]);
  });

  it("falls back to KV.memories when an indexed entry is a saved memory (#265)", async () => {
    // mem::remember writes to KV.memories under the synthetic sessionId
    // "memory" — the BM25 index sees that synthetic sessionId, but
    // KV.observations("memory") never has anything.
    const indexable = makeObs({
      id: "mem_abc",
      sessionId: "memory",
      title: "Test memory for search",
      narrative: "Test memory for search",
      concepts: ["test", "search"],
    });
    bm25.add(indexable);

    const memory = {
      id: "mem_abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: "fact",
      title: "Test memory for search",
      content: "Test memory for search",
      concepts: ["test", "search"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_abc", memory);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("test memory search");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("mem_abc");
    expect(results[0].observation.narrative).toBe("Test memory for search");
    expect(results[0].observation.concepts).toEqual(["test", "search"]);
  });
});

describe("HybridSearch graph weight 0", () => {
  it("runs no graph traversal when the graph weight is 0", async () => {
    const { GraphRetrieval } = await import("../src/functions/graph-retrieval.js");
    const byEntities = vi.spyOn(GraphRetrieval.prototype, "searchByEntities");
    const expand = vi.spyOn(GraphRetrieval.prototype, "expandFromChunks");
    const bm25 = new SearchIndex();
    const kv = mockKV();
    const obs = makeObs();
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const off = new HybridSearch(bm25, null, null, kv as never, 0.4, 0.6, 0);
    await off.search("React auth middleware", 5);
    expect(byEntities).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();

    const on = new HybridSearch(bm25, null, null, kv as never, 0.4, 0.6, 0.3);
    await on.search("React auth middleware", 5);
    expect(byEntities).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
