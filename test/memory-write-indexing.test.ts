import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { registerWorkingMemoryFunctions } from "../src/functions/working-memory.js";
import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { registerMeshFunction } from "../src/functions/mesh.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { getSearchIndex } from "../src/functions/search.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { MEMORY_WRITE_LOCK, memoryToIndexDoc } from "../src/state/memory-utils.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import type { CompactSearchResult, CompressedObservation, Memory, MemoryProvider, Session } from "../src/types.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      functions.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      return functions.get(id)!(payload);
    },
  };
}

function memory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "fact",
    title: `title ${id}`,
    content: `zebracorn ${id}`,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

const indexed = (id: string) => getSearchIndex().has(id);

function searchIds(sdk: ReturnType<typeof mockSdk>, kv: ReturnType<typeof mockKV>) {
  const hybrid = new HybridSearch(getSearchIndex(), null, null, kv as never, 1, 0, 0);
  registerSmartSearchFunction(sdk as never, kv as never, (query) => hybrid.prepareSearch(query));
  return async (query: string) => {
    const { results } = await sdk.trigger("mem::smart-search", { query }) as { results: CompactSearchResult[] };
    return results.map(({ obsId }) => obsId);
  };
}


describe("Memory write paths keep the live search index current", () => {
  beforeEach(() => {
    const index = getSearchIndex();
    index.clear();
    for (let i = 0; i < 40; i++) {
      index.add(memoryToIndexDoc(memory(`filler_${i}`, { content: `database migration batch ${i}` })), "memory");
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["creates", "evolves"])("mem::consolidate indexes a Memory it %s", async (mode) => {
    const sdk = mockSdk();
    const kv = mockKV();
    const session: Session = {
      id: "s1",
      project: "api",
      cwd: "/srv/api",
      startedAt: new Date().toISOString(),
      status: "completed",
      observationCount: 3,
    };
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < 3; i++) {
      const o: CompressedObservation = {
        id: `o${i}`,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        type: "decision",
        title: `observation ${i}`,
        facts: [],
        narrative: `narrative ${i}`,
        concepts: ["auth"],
        files: [],
        importance: 8,
      };
      await kv.set(KV.observations("s1"), o.id, o);
    }
    const provider = {
      name: "mock",
      compress: async () =>
        `<memory><type>pattern</type><title>auth rule</title><content>content</content><strength>7</strength></memory>`,
      embed: vi.fn(),
      embedBatch: vi.fn(),
      dimensions: 384,
      compressionModel: "mock-model",
    } as unknown as MemoryProvider;
    const search = searchIds(sdk, kv);
    const old = memory("mem_old", { type: "pattern", title: "auth rule", project: "api" });
    if (mode === "evolves") {
      await kv.set(KV.memories, old.id, old);
      getSearchIndex().add(memoryToIndexDoc(old), "memory");
      expect(await search("auth rule")).toEqual([old.id]);
    }
    registerConsolidateFunction(sdk as never, kv as never, provider);
    await sdk.trigger("mem::consolidate", { project: "api", minObservations: 1 });
    const created = (await kv.list<Memory>(KV.memories)).find((row) => row.id !== old.id)!;
    expect(created).toBeDefined();
    expect(await search("auth rule")).toEqual([created.id]);
    if (mode === "evolves") expect(indexed(old.id)).toBe(false);
  });

  it("mem::auto-page indexes the Memory it pages out", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerWorkingMemoryFunctions(sdk as never, kv as never, 10);
    await sdk.trigger("mem::core-add", { content: "a long pinned entry that exceeds the tiny budget", importance: 3 });
    await sdk.trigger("mem::auto-page", {});
    const [paged] = await kv.list<Memory>(KV.memories);
    expect(paged).toBeDefined();
    expect(await searchIds(sdk, kv)("pinned entry")).toContain(paged.id);
  });

  it("mem::heal removes a Memory it marks non-latest from the index", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerDiagnosticsFunction(sdk as never, kv as never);
    const old = memory("mem_old");
    const next = memory("mem_new", { supersedes: ["mem_old"], version: 2 });
    await kv.set(KV.memories, old.id, old);
    await kv.set(KV.memories, next.id, next);
    getSearchIndex().add(memoryToIndexDoc(old), "memory");
    getSearchIndex().add(memoryToIndexDoc(next), "memory");
    const search = searchIds(sdk, kv);
    expect(await search("zebracorn")).toContain(old.id);
    await sdk.trigger("mem::heal", { categories: ["memories"] });
    expect((await kv.get<Memory>(KV.memories, "mem_old"))!.isLatest).toBe(false);
    expect(await search("zebracorn")).toEqual([next.id]);
    expect(indexed(old.id)).toBe(false);
  });

  it("keeps a Memory indexed when heal's successor disappears after listing", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerDiagnosticsFunction(sdk as never, kv as never);
    const old = memory("mem_old");
    const next = memory("mem_new", { supersedes: [old.id] });
    await kv.set(KV.memories, old.id, old);
    await kv.set(KV.memories, next.id, next);
    getSearchIndex().add(memoryToIndexDoc(old), "memory");
    let heal!: Promise<unknown>;
    try {
      await withKeyedLock(MEMORY_WRITE_LOCK, async () => {
        heal = sdk.trigger("mem::heal", { categories: ["memories"] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await kv.delete(KV.memories, next.id);
      });
    } finally {
      await heal;
    }
    expect(await heal).toMatchObject({ fixed: 0, skipped: 1 });
    expect(await searchIds(sdk, kv)("zebracorn")).toEqual([old.id]);
  });

  it("keeps mesh Memory application behind the Memory write lock", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMeshFunction(sdk as never, kv as never, "token");
    const incoming = memory("mem_incoming");
    let receive!: Promise<unknown>;

    try {
      await withKeyedLock(MEMORY_WRITE_LOCK, async () => {
        receive = sdk.trigger("mem::mesh-receive", { memories: [incoming] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await kv.get(KV.memories, incoming.id)).toBeNull();
        expect(indexed(incoming.id)).toBe(false);
      });
    } finally {
      await receive;
    }
    expect(await kv.get(KV.memories, incoming.id)).toEqual(incoming);
    expect(indexed(incoming.id)).toBe(true);
  });

  it.each(["receive", "sync"])("mesh %s applies live-index updates and rejects stale rows", async (path) => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMeshFunction(sdk as never, kv as never, "token");
    const old = memory("mem_old");
    const closed = { ...old, isLatest: false, updatedAt: "2026-02-01T00:00:00.000Z" };
    const fresh = memory("mem_fresh", { updatedAt: "2026-02-01T00:00:00.000Z" });
    await kv.set(KV.memories, old.id, old);
    getSearchIndex().add(memoryToIndexDoc(old), "memory");
    const search = searchIds(sdk, kv);
    expect(await search("zebracorn")).toEqual([old.id]);

    const registration = path === "sync" ? await sdk.trigger("mem::mesh-register", {
      url: "https://peer.example.com", name: "test peer",
    }) as { peer: { id: string } } : undefined;
    const apply = async (memories: Memory[]) => {
      if (!registration) {
        await sdk.trigger("mem::mesh-receive", { memories });
        return;
      }
      vi.stubGlobal("fetch", async () => Response.json({ memories }));
      const result = await sdk.trigger("mem::mesh-sync", { peerId: registration.peer.id, direction: "pull" });
      expect(result).toMatchObject({ success: true, results: [{ errors: [] }] });
    };
    await apply([closed, fresh]);
    expect(await search("zebracorn")).toEqual([fresh.id]);
    expect(indexed(old.id)).toBe(false);
    await apply([old]);
    expect(await search("zebracorn")).toEqual([fresh.id]);
    expect((await kv.get<Memory>(KV.memories, old.id))!.isLatest).toBe(false);
  });
});
