import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
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
});
