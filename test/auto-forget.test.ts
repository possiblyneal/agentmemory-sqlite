import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import {
  getSearchIndex,
} from "../src/functions/search.js";
import { memoryToObservation, memoryToIndexDoc } from "../src/state/memory-utils.js";
import type { Memory, CompressedObservation, Session } from "../src/types.js";

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
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<unknown> => {
      const row = store.get(scope)?.get(key) as Record<string, unknown>;
      for (const op of ops) {
        if (op.type === "set") row[op.path] = op.value;
        else delete row[op.path];
      }
      return row;
    },
    listPage: async <T>(scope: string, after: string | undefined, limit: number) => [...(store.get(scope)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => !after || key > after).slice(0, limit).map(([key, value]) => ({ key, value: value as T })),
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

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "pattern",
    title: "Test memory",
    content: "This is a test memory with enough words for comparison",
    concepts: ["test"],
    files: [],
    sessionIds: ["ses_1"],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

describe("Auto-Forget Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerAutoForgetFunction(sdk as never, kv as never);
  });

  it("cleans Facets of expired Memories without changing the indexed deletion", async () => {
    const memory = makeMemory({ id: "mem_expired", forgetAfter: "2020-01-01T00:00:00Z" });
    await kv.set("mem:memories", memory.id, memory);
    await kv.set("mem:facets", "facet", { id: "facet", targetId: memory.id });
    getSearchIndex().add(memoryToObservation(memory));
    await sdk.trigger("mem::auto-forget", {});
    expect(await kv.get("mem:facets", "facet")).toBeNull();
    expect(await kv.get("mem:memories", memory.id)).toBeNull();
    expect(getSearchIndex().has(memory.id)).toBe(false);
  });

  it("keeps deletion and index cleanup when Facet lookup fails", async () => {
    const memory = makeMemory({ id: "mem_failed_cleanup", forgetAfter: "2020-01-01T00:00:00Z" });
    await kv.set("mem:memories", memory.id, memory);
    getSearchIndex().add(memoryToObservation(memory));
    kv.listPage = async () => { throw new Error("Facet lookup failed"); };
    await sdk.trigger("mem::auto-forget", {});
    expect(await kv.get("mem:memories", memory.id)).toBeNull();
    expect(getSearchIndex().has(memory.id)).toBe(false);
  });

  it("detects and deletes TTL-expired memories", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    await kv.set("mem:memories", "mem_expired", expired);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      ttlExpired: string[];
    };

    expect(result.ttlExpired).toContain("mem_expired");
    const deleted = await kv.get("mem:memories", "mem_expired");
    expect(deleted).toBeNull();
  });

  it("detects contradiction between very similar memories", async () => {
    const mem1 = makeMemory({
      id: "mem_1",
      content: "Use React hooks for state management in all components",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const mem2 = makeMemory({
      id: "mem_2",
      content: "Use React hooks for state management in all components",
      createdAt: "2026-02-01T00:00:00Z",
    });
    await kv.set("mem:memories", "mem_1", mem1);
    await kv.set("mem:memories", "mem_2", mem2);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      contradictions: Array<{
        memoryA: string;
        memoryB: string;
        similarity: number;
      }>;
    };

    expect(result.contradictions.length).toBe(1);
    const older = await kv.get<Memory>("mem:memories", "mem_1");
    expect(older!.isLatest).toBe(false);
  });

  it.each(["deleted", "demoted", "edited", "retagged"])("keeps the older Memory when the newer one was %s after listing", async (change) => {
    const older = makeMemory({ id: "mem_older", createdAt: "2026-01-01T00:00:00Z" });
    const newer = makeMemory({ id: "mem_newer", createdAt: "2026-02-01T00:00:00Z" });
    await kv.set("mem:memories", older.id, older);
    await kv.set("mem:memories", newer.id, newer);
    const list = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      const snapshot = await list<T>(scope);
      if (scope === "mem:memories") {
        if (change === "deleted") await kv.delete(scope, newer.id);
        else await kv.set(scope, newer.id, {
          ...newer,
          ...(change === "demoted" ? { isLatest: false }
            : change === "edited" ? { content: "Deploy the unrelated service on Friday" }
            : { concepts: ["unrelated"] }),
        });
      }
      return snapshot;
    };

    expect(await sdk.trigger("mem::auto-forget", {})).toMatchObject({ contradictions: [] });
    expect(await kv.get("mem:memories", older.id)).toMatchObject({ isLatest: true });
    expect(await kv.list("mem:audit")).toEqual([]);
  });

  it("removes the older contradicted memory from the live index", async () => {
    getSearchIndex().clear();
    const content = "Use React hooks for state management in all components";
    const mem1 = makeMemory({ id: "mem_1", content, createdAt: "2026-01-01T00:00:00Z" });
    const mem2 = makeMemory({ id: "mem_2", content, createdAt: "2026-02-01T00:00:00Z" });
    for (const m of [mem1, mem2]) {
      await kv.set("mem:memories", m.id, m);
      getSearchIndex().add(memoryToIndexDoc(m), "memory");
    }

    await sdk.trigger("mem::auto-forget", {});

    expect(getSearchIndex().has("mem_1")).toBe(false);
    expect(getSearchIndex().has("mem_2")).toBe(true);
  });

  it("evicts low-value old observations", async () => {
    const session: Session = {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2025-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const oldLowObs: CompressedObservation = {
      id: "obs_old",
      sessionId: "ses_1",
      timestamp: "2025-01-01T00:00:00Z",
      type: "other",
      title: "trivial event",
      facts: [],
      narrative: "nothing important",
      concepts: [],
      files: [],
      importance: 1,
    };
    await kv.set("mem:obs:ses_1", "obs_old", oldLowObs);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      lowValueObs: string[];
    };

    expect(result.lowValueObs).toContain("obs_old");
  });

  it("lowers the Session's observationCount by the Observations it deletes", async () => {
    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2025-01-01T00:00:00Z",
      status: "completed",
      observationCount: 3,
    } satisfies Session);
    const observation = (id: string, timestamp: string): CompressedObservation => ({
      id,
      sessionId: "ses_1",
      timestamp,
      type: "other",
      title: "trivial event",
      facts: [],
      narrative: "nothing important",
      concepts: [],
      files: [],
      importance: 1,
    });
    await kv.set("mem:obs:ses_1", "old_a", observation("old_a", "2025-01-01T00:00:00Z"));
    await kv.set("mem:obs:ses_1", "old_b", observation("old_b", "2025-01-02T00:00:00Z"));
    await kv.set("mem:obs:ses_1", "recent", observation("recent", new Date().toISOString()));

    await sdk.trigger("mem::auto-forget", {});

    expect(await kv.list("mem:obs:ses_1")).toHaveLength(1);
    expect(await kv.get<Session>("mem:sessions", "ses_1")).toMatchObject({
      observationCount: 1,
    });
  });

  it("dryRun mode identifies but does not delete anything", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    await kv.set("mem:memories", "mem_expired", expired);

    const result = (await sdk.trigger("mem::auto-forget", { dryRun: true })) as {
      ttlExpired: string[];
      dryRun: boolean;
    };

    expect(result.dryRun).toBe(true);
    expect(result.ttlExpired).toContain("mem_expired");

    const stillExists = await kv.get("mem:memories", "mem_expired");
    expect(stillExists).not.toBeNull();
  });

  describe("search-index cleanup", () => {
    beforeEach(() => {
      getSearchIndex().clear();
    });

    it("removes TTL-expired memories from the BM25 index", async () => {
      const expired = makeMemory({
        id: "mem_expired",
        forgetAfter: "2020-01-01T00:00:00Z",
      });
      await kv.set("mem:memories", "mem_expired", expired);
      getSearchIndex().add(memoryToObservation(expired));
      expect(getSearchIndex().has("mem_expired")).toBe(true);

      await sdk.trigger("mem::auto-forget", {});

      expect(getSearchIndex().has("mem_expired")).toBe(false);
    });

    it("removes evicted low-value observations from the BM25 index", async () => {
      const session: Session = {
        id: "ses_1",
        project: "my-project",
        cwd: "/tmp",
        startedAt: "2025-01-01T00:00:00Z",
        status: "completed",
        observationCount: 1,
      };
      await kv.set("mem:sessions", "ses_1", session);

      const oldLowObs: CompressedObservation = {
        id: "obs_old",
        sessionId: "ses_1",
        timestamp: "2025-01-01T00:00:00Z",
        type: "other",
        title: "trivial event",
        facts: [],
        narrative: "nothing important",
        concepts: [],
        files: [],
        importance: 1,
      };
      await kv.set("mem:obs:ses_1", "obs_old", oldLowObs);
      getSearchIndex().add(oldLowObs);
      expect(getSearchIndex().has("obs_old")).toBe(true);

      await sdk.trigger("mem::auto-forget", {});

      expect(getSearchIndex().has("obs_old")).toBe(false);
    });

    it("leaves the index untouched on dryRun", async () => {
      const expired = makeMemory({
        id: "mem_expired",
        forgetAfter: "2020-01-01T00:00:00Z",
      });
      await kv.set("mem:memories", "mem_expired", expired);
      getSearchIndex().add(memoryToObservation(expired));

      await sdk.trigger("mem::auto-forget", { dryRun: true });

      // dryRun must not mutate the index.
      expect(getSearchIndex().has("mem_expired")).toBe(true);
    });
  });

  it("does not flag non-similar memories as contradictions", async () => {
    const mem1 = makeMemory({
      id: "mem_1",
      content: "We use TypeScript with strict mode enabled for all backend services",
    });
    const mem2 = makeMemory({
      id: "mem_2",
      content: "The deployment pipeline runs integration tests before merging to main",
    });
    await kv.set("mem:memories", "mem_1", mem1);
    await kv.set("mem:memories", "mem_2", mem2);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      contradictions: unknown[];
    };

    expect(result.contradictions.length).toBe(0);
  });

  describe("contradiction pass stays within one scope (#437)", () => {
    const content = "Use React hooks for state management in all components";

    it.each([
      ["different projects", { project: "alpha" }, { project: "beta" }],
      ["missing and present project", {}, { project: "alpha" }],
      ["different agents", { project: "alpha", agentId: "a" }, { project: "alpha", agentId: "b" }],
      ["missing and present agent", { project: "alpha" }, { project: "alpha", agentId: "a" }],
      ["a Global and a scoped Memory", { project: "alpha", global: true }, { project: "alpha" }],
    ])("keeps both latest across %s", async (_label, a, b) => {
      await kv.set("mem:memories", "mem_1", makeMemory({ id: "mem_1", content, createdAt: "2026-01-01T00:00:00Z", ...a }));
      await kv.set("mem:memories", "mem_2", makeMemory({ id: "mem_2", content, createdAt: "2026-02-01T00:00:00Z", ...b }));

      const result = (await sdk.trigger("mem::auto-forget", {})) as { contradictions: unknown[] };

      expect(result.contradictions).toHaveLength(0);
      expect((await kv.get<Memory>("mem:memories", "mem_1"))!.isLatest).toBe(true);
      expect((await kv.get<Memory>("mem:memories", "mem_2"))!.isLatest).toBe(true);
    });

    it("still supersedes the older of two in one project", async () => {
      await kv.set("mem:memories", "mem_1", makeMemory({ id: "mem_1", content, project: "alpha", createdAt: "2026-01-01T00:00:00Z" }));
      await kv.set("mem:memories", "mem_2", makeMemory({ id: "mem_2", content, project: "alpha", createdAt: "2026-02-01T00:00:00Z" }));

      await sdk.trigger("mem::auto-forget", {});

      expect((await kv.get<Memory>("mem:memories", "mem_1"))!.isLatest).toBe(false);
    });
  });

  it("keeps the image ref when the TTL delete fails (#437)", async () => {
    await kv.set("mem:memories", "mem_img", makeMemory({
      id: "mem_img",
      forgetAfter: "2020-01-01T00:00:00Z",
      imageRef: "/images/a.png",
    }));
    await kv.set("mem:image-refs", "/images/a.png", 2);
    const realDelete = kv.delete;
    kv.delete = async (scope, key) => {
      if (scope === "mem:memories") throw new Error("disk full");
      return realDelete(scope, key);
    };

    await expect(sdk.trigger("mem::auto-forget", {})).rejects.toThrow("disk full");

    expect(await kv.get("mem:image-refs", "/images/a.png")).toBe(2);
  });
});
