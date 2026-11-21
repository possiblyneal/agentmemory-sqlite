import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
import { getSearchIndex } from "../src/functions/search.js";
import { memoryToIndexDoc } from "../src/state/memory-utils.js";
import type { CompressedObservation, Memory, MemoryProvider, Session } from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from((store.get(scope) ?? new Map()).values()) as T[],
  };
}

function makeMockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (id: string, data?: unknown) => functions.get(id)!(data),
  };
}

function rewordingProvider(): MemoryProvider {
  let n = 0;
  return {
    name: "mock",
    compress: vi.fn().mockImplementation(async () => {
      n++;
      return `<memory><type>pattern</type><title>reworded title ${n}</title>
        <content>content ${n}</content><strength>7</strength></memory>`;
    }),
    embed: vi.fn(),
    embedBatch: vi.fn(),
    dimensions: 384,
    compressionModel: "mock-model",
  } as unknown as MemoryProvider;
}

const session: Session = {
  id: "s1",
  project: "api",
  cwd: "/srv/api",
  startedAt: new Date().toISOString(),
  status: "completed",
  observationCount: 3,
};

function obs(id: string, concepts: string[]): CompressedObservation {
  return {
    id,
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    type: "decision",
    title: `observation ${id}`,
    facts: [],
    narrative: `narrative ${id}`,
    concepts,
    files: [],
    importance: 8,
  };
}

async function setup(concepts: string[][]) {
  const sdk = makeMockSdk();
  const kv = makeMockKV();
  await kv.set(KV.sessions, session.id, session);
  for (let i = 0; i < concepts.length; i++) {
    await kv.set(KV.observations("s1"), `o${i}`, obs(`o${i}`, concepts[i]));
  }
  registerConsolidateFunction(sdk as never, kv as never, rewordingProvider());
  const run = () => sdk.trigger("mem::consolidate", { project: "api", minObservations: 1 });
  const latest = async () =>
    (await kv.list<Memory>(KV.memories)).filter((m) => m.isLatest);
  return { kv, run, latest };
}

describe("mem::consolidate dedup", () => {
  it("writes nothing on a second run over unchanged input", async () => {
    const { run, kv } = await setup([["auth"], ["auth"], ["auth"]]);
    expect(await run()).toMatchObject({ consolidated: 1 });
    expect(await run()).toMatchObject({ consolidated: 0 });
    expect(await kv.list(KV.memories)).toHaveLength(1);
  });

  it("evolves the latest Memory when a group only partly overlaps its sources", async () => {
    const { run, kv, latest } = await setup([["auth"], ["auth"], ["auth"]]);
    await run();
    const [first] = await latest();
    await kv.set(KV.observations("s1"), "o3", obs("o3", ["auth"]));
    await run();
    const now = await latest();
    expect(now).toHaveLength(1);
    expect(now[0].parentId).toBe(first.id);
    expect(now[0].version).toBe(2);
    expect(now[0].sourceObservationIds).toEqual(expect.arrayContaining(["o0", "o1", "o2", "o3"]));
  });

  it("produces one Memory from two overlapping groups in one run", async () => {
    const { run, latest } = await setup([
      ["auth", "login"],
      ["auth", "login"],
      ["auth", "login"],
    ]);
    await run();
    expect(await latest()).toHaveLength(1);
  });

  it("moves the live index from the evolved Memory to its new version", async () => {
    getSearchIndex().clear();
    const { run, kv, latest } = await setup([["auth"], ["auth"], ["auth"]]);
    await run();
    const [first] = await latest();
    getSearchIndex().add(memoryToIndexDoc(first), "memory");
    await kv.set(KV.observations("s1"), "o3", obs("o3", ["auth"]));
    await run();
    const [second] = await latest();
    expect(getSearchIndex().has(first.id)).toBe(false);
    expect(getSearchIndex().has(second.id)).toBe(true);
  });

  it("indexes the successor when the predecessor audit fails", async () => {
    getSearchIndex().clear();
    const { run, kv, latest } = await setup([["auth", "login"], ["auth", "login"], ["auth", "login"]]);
    await run();
    const [first] = await latest();
    await kv.set(KV.observations("s1"), "o3", obs("o3", ["auth", "login"]));
    const set = kv.set.bind(kv);
    let auditFailed = false;
    kv.set = async (scope, key, data) => {
      if (scope === KV.audit && !auditFailed) {
        auditFailed = true;
        throw new Error("audit write failed");
      }
      return set(scope, key, data);
    };
    await run();
    const current = await latest();
    expect(current).toHaveLength(1);
    const [second] = current;
    expect(auditFailed).toBe(true);
    expect(second.parentId).toBe(first.id);
    expect(getSearchIndex().has(first.id)).toBe(false);
    expect(getSearchIndex().has(second.id)).toBe(true);
    await run();
    expect(getSearchIndex().has(second.id)).toBe(true);
  });

  it("keeps one latest Memory when two runs overlap", async () => {
    const { run, latest } = await setup([["auth"], ["auth"], ["auth"]]);
    await Promise.all([run(), run()]);
    expect(await latest()).toHaveLength(1);
  });

  it("keeps the previous version latest when writing its successor fails", async () => {
    const { run, kv, latest } = await setup([["auth"], ["auth"], ["auth"]]);
    await run();
    const [first] = await latest();
    await kv.set(KV.observations("s1"), "o3", obs("o3", ["auth"]));
    const set = kv.set.bind(kv);
    kv.set = async (scope, key, data) => {
      if (scope === KV.memories && key !== first.id) throw new Error("disk full");
      return set(scope, key, data);
    };
    await run();
    expect((await latest()).map((m) => m.id)).toEqual([first.id]);
  });

  it("counts a failed model call toward the ten-call budget", async () => {
    const groups = Array.from({ length: 12 }, (_, g) => [`topic${g}`]);
    const concepts = groups.flatMap((g) => [g, g, g]);
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < concepts.length; i++) {
      await kv.set(KV.observations("s1"), `o${i}`, obs(`o${i}`, concepts[i]));
    }
    const provider = rewordingProvider();
    (provider.compress as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("provider down"));
    registerConsolidateFunction(sdk as never, kv as never, provider);
    await sdk.trigger("mem::consolidate", { project: "api", minObservations: 1 });
    expect(provider.compress).toHaveBeenCalledTimes(10);
  });
});
