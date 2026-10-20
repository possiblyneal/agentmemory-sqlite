import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSearchFunction, getSearchIndex, rebuildIndex, setVectorIndex, setEmbeddingProvider, getVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

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
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("mem::search", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);

    const obsA: CompressedObservation = {
      id: "obs_a",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Auth middleware decision",
      subtitle: "JWT strategy",
      facts: ["Use rotating refresh tokens"],
      narrative: "Implemented auth middleware with JWT refresh rotation.",
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 8,
    };
    const obsB: CompressedObservation = {
      id: "obs_b",
      sessionId: "ses_1",
      timestamp: "2026-01-02T00:00:00Z",
      type: "file_edit",
      title: "UI button styling",
      facts: ["Updated primary button color"],
      narrative: "Adjusted button styles in the settings page.",
      concepts: ["ui", "css"],
      files: ["src/ui/button.tsx"],
      importance: 4,
    };

    await kv.set(KV.observations("ses_1"), obsA.id, obsA);
    await kv.set(KV.observations("ses_1"), obsB.id, obsB);

    // Module-level SearchIndex singleton would leak across tests; reset.
    getSearchIndex().clear();
    // mem::search awaits a shared rebuild on a cold index; the explicit call
    // here pre-populates the index deterministically so the query assertions
    // below never depend on that cold-start path.
    await rebuildIndex(kv as never);
  });

  it("returns full format by default", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
    })) as { format: string; results: Array<{ observation: CompressedObservation }> };

    expect(result.format).toBe("full");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.observation.id).toBe("obs_a");
  });

  it("returns compact format when requested", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth",
      format: "compact",
    })) as { format: string; results: Array<{ obsId: string; title: string }> };

    expect(result.format).toBe("compact");
    expect(result.results[0]?.obsId).toBe("obs_a");
    expect(result.results[0]?.title).toBe("Auth middleware decision");
  });

  it("returns narrative text and respects token budget", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth ui",
      format: "narrative",
      token_budget: 20,
    })) as {
      format: string;
      results: Array<{ obsId: string }>;
      text: string;
      tokens_used: number;
      tokens_budget: number;
      truncated: boolean;
    };

    expect(result.format).toBe("narrative");
    expect(result.tokens_budget).toBe(20);
    expect(result.tokens_used).toBeLessThanOrEqual(20);
    expect(typeof result.text).toBe("string");
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("shortens an oversized top match to fit the budget instead of dropping it", async () => {
    const oversized: CompressedObservation = {
      id: "obs_big",
      sessionId: "ses_1",
      timestamp: "2026-01-03T00:00:00Z",
      type: "decision",
      title: "Auth middleware decision revisited",
      facts: ["Auth middleware keeps JWT"],
      narrative: "auth middleware ".repeat(400),
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 9,
    };
    const small: CompressedObservation = {
      id: "obs_small",
      sessionId: "ses_1",
      timestamp: "2026-01-04T00:00:00Z",
      type: "decision",
      title: "Auth middleware follow-up",
      facts: ["Auth middleware logs"],
      narrative: "Added auth middleware logging.",
      concepts: ["auth"],
      files: ["src/auth.ts"],
      importance: 8,
    };
    await kv.set(KV.observations("ses_1"), oversized.id, oversized);
    await kv.set(KV.observations("ses_1"), small.id, small);
    getSearchIndex().clear();
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
      token_budget: 600,
    })) as {
      results: Array<{ observation: CompressedObservation }>;
      truncated: boolean;
      content_truncated: boolean;
      tokens_used: number;
    };

    const top = result.results[0].observation;
    expect(top.id).toBe("obs_big");
    expect(top.narrative.length).toBeGreaterThan(0);
    expect(top.narrative.length).toBeLessThan(oversized.narrative.length);
    expect(result.tokens_used).toBeLessThanOrEqual(600);
    expect(result.truncated).toBe(true);
    expect(result.content_truncated).toBe(true);
  });

  it("reports truncated only when a record was skipped", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
      format: "compact",
      token_budget: 10_000,
    })) as { results: Array<{ obsId: string }>; truncated: boolean };

    expect(result.results.map((r) => r.obsId)).toEqual(["obs_a"]);
    expect(result.truncated).toBe(false);
  });

  it("rejects invalid format values", async () => {
    await expect(
      sdk.trigger("mem::search", { query: "auth", format: "verbose" }),
    ).rejects.toThrow("format must be one of");
  });

  it("surfaces saved memories from KV.memories (#265)", async () => {
    // mem::remember persists to KV.memories under a synthetic sessionId
    // ("memory") that has no corresponding KV.observations entry. mem::search
    // must fall back to KV.memories or memory_recall returns empty.
    await kv.set(KV.memories, "mem_x1", {
      id: "mem_x1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      title: "Pineapple belongs on pizza",
      content: "Pineapple belongs on pizza for testing fallback path.",
      concepts: ["pineapple", "pizza"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    });
    // Force the rebuild to pick up the new memory (mem::search only
    // rebuilds on first call when idx.size === 0).
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "pineapple pizza",
      format: "compact",
    })) as { results: Array<{ obsId: string; title: string }> };

    const hit = result.results.find((r) => r.obsId === "mem_x1");
    expect(hit).toBeDefined();
    expect(hit?.title).toBe("Pineapple belongs on pizza");
  });

  it("rebuildIndex populates the vector index", async () => {
    const mockEmbedder = {
      name: "test",
      dimensions: 3,
      embed: async (_text: string) => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (_texts: string[]) =>
        _texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    setEmbeddingProvider(mockEmbedder);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv as never);

    const vi = getVectorIndex();
    expect(vi).not.toBeNull();
    expect(vi!.size).toBeGreaterThan(0);

    // Cleanup
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });
});

describe("mem::search recency", () => {
  const NOW = "2026-10-20T12:00:00.000Z";
  const text = "Whitespace rule: indent in every source file of the repository";

  function obs(id: string, timestamp: string, narrative = text): CompressedObservation {
    return {
      id, sessionId: "ses_r", timestamp, type: "decision", title: "Whitespace rule",
      facts: [], narrative, concepts: [], files: [], importance: 6,
    };
  }

  async function search(seed: CompressedObservation[], limit?: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const sdk = mockSdk();
    const kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);
    getSearchIndex().clear();
    for (const o of seed) {
      await kv.set(KV.observations("ses_r"), o.id, o);
      getSearchIndex().add(o);
    }
    try {
      const out = (await sdk.trigger("mem::search", { query: "whitespace rule indent source file", limit })) as { results: Array<{ observation: { id: string } }> };
      return out.results.map((r) => r.observation.id);
    } finally {
      vi.useRealTimers();
    }
  }

  it("ranks the newer Observation first when two match equally", async () => {
    const ids = await search([obs("obs_old", "2026-09-01T10:00:00.000Z"), obs("obs_new", "2026-10-10T10:00:00.000Z")]);
    expect(ids).toEqual(["obs_new", "obs_old"]);
  });

  it("keeps a clearly stronger older match ahead of a newer weak one", async () => {
    const strong = obs("obs_old", "2026-09-01T10:00:00.000Z", `${text} whitespace rule indent indent source file source file`);
    const weak = obs("obs_new", "2026-10-10T10:00:00.000Z", "Whitespace note about a file");
    expect(await search([weak, strong])).toEqual(["obs_old", "obs_new"]);
  });

  it("caps an older near-twin below the newer one and leaves an unrelated older Observation in place", async () => {
    const unrelated = obs("obs_unrelated", "2026-08-01T10:00:00.000Z", "Whitespace rule indent source file whitespace rule indent source file lint formatter config");
    const twinOld = obs("obs_twin_old", "2026-09-01T10:00:00.000Z", `${text} whitespace rule whitespace rule indent indent source file source file`);
    const twinNew = obs("obs_twin_new", "2026-10-10T10:00:00.000Z", text);
    const ids = await search([twinOld, unrelated, twinNew]);
    expect(ids.indexOf("obs_twin_new")).toBeLessThan(ids.indexOf("obs_twin_old"));
    expect(ids.indexOf("obs_unrelated")).toBeLessThan(ids.indexOf("obs_twin_new"));
  });

  it("applies the limit after recency ranking", async () => {
    const ids = await search([obs("obs_old", "2026-09-01T10:00:00.000Z"), obs("obs_new", "2026-10-10T10:00:00.000Z")], 1);
    expect(ids).toEqual(["obs_new"]);
  });
});
