import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { registerRelationsFunction } from "../src/functions/relations.js";
import { registerGovernanceFunction } from "../src/functions/governance.js";
import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { registerRetentionFunctions } from "../src/functions/retention.js";
import type { Memory } from "../src/types.js";

const MEMORIES = "mem:memories";
const tick = () => new Promise((r) => setTimeout(r, 15));

function gatedKV() {
  const store = new Map<string, Map<string, unknown>>();
  let gate: { scope: string; key: string; reached: () => void; open: Promise<void> } | null = null;
  const clone = <T>(v: T): T => structuredClone(v);
  const kv = {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const row = store.get(scope)?.get(key);
      return row === undefined ? null : clone(row as T);
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (gate && gate.scope === scope && gate.key === key) {
        const g = gate;
        gate = null;
        g.reached();
        await g.open;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, clone(data));
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []).map((v) => clone(v as T)),
  };
  function pauseNextSet(scope: string, key: string) {
    let release!: () => void;
    let reached!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const hit = new Promise<void>((r) => (reached = r));
    gate = { scope, key, reached, open };
    return { release, hit };
  }
  return { kv, pauseNextSet };
}

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
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "fact",
    title: "Lock probe",
    content: "zebra quartz lattice meridian harbor",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

describe("Memory writers serialize with deletes and relates", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let env: ReturnType<typeof gatedKV>;

  beforeEach(() => {
    sdk = mockSdk();
    env = gatedKV();
    registerRememberFunction(sdk as never, env.kv as never);
    registerRelationsFunction(sdk as never, env.kv as never);
    registerGovernanceFunction(sdk as never, env.kv as never);
    registerAutoForgetFunction(sdk as never, env.kv as never);
    registerEvictFunction(sdk as never, env.kv as never);
    registerRetentionFunctions(sdk as never, env.kv as never);
  });

  async function deleteDuringReinforce(
    seed: Partial<Memory>,
    del: () => Promise<unknown>,
  ) {
    const x = makeMemory({ id: "mem_x", ...seed });
    await env.kv.set(MEMORIES, x.id, x);
    const gate = env.pauseNextSet(MEMORIES, x.id);
    const save = sdk.trigger("mem::remember", { content: x.content });
    await gate.hit;
    const deletion = del();
    await tick();
    gate.release();
    await Promise.all([save, deletion]);
    return env.kv.get<Memory>(MEMORIES, x.id);
  }

  it("governance-delete is not undone by a remember that read the Memory first", async () => {
    const left = await deleteDuringReinforce({}, () =>
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_x"] }),
    );
    expect(left).toBeNull();
  });

  it("governance-bulk is not undone by a remember that read the Memory first", async () => {
    const left = await deleteDuringReinforce({}, () =>
      sdk.trigger("mem::governance-bulk", { type: ["fact"] }),
    );
    expect(left).toBeNull();
  });

  it("forget is not undone by a remember that read the Memory first", async () => {
    const left = await deleteDuringReinforce({}, () =>
      sdk.trigger("mem::forget", { memoryId: "mem_x" }),
    );
    expect(left).toBeNull();
  });

  it("auto-forget TTL is not undone by a remember that read the Memory first", async () => {
    const left = await deleteDuringReinforce({ forgetAfter: "2020-01-01T00:00:00Z" }, () =>
      sdk.trigger("mem::auto-forget", {}),
    );
    expect(left).toBeNull();
  });

  it("evict TTL is not undone by a remember that read the Memory first", async () => {
    const left = await deleteDuringReinforce({ forgetAfter: "2020-01-01T00:00:00Z" }, () =>
      sdk.trigger("mem::evict", {}),
    );
    expect(left).toBeNull();
  });

  it("retention-evict is not undone by a remember that read the Memory first", async () => {
    await env.kv.set("mem:retention", "mem_x", {
      memoryId: "mem_x",
      score: 0,
      source: "episodic",
    });
    const left = await deleteDuringReinforce({}, () =>
      sdk.trigger("mem::retention-evict", { threshold: 1 }),
    );
    expect(left).toBeNull();
  });

  it("two relates sharing a Memory keep both relatedIds", async () => {
    for (const id of ["mem_a", "mem_b", "mem_c"]) {
      await env.kv.set(MEMORIES, id, makeMemory({ id, content: `${id} unrelated text` }));
    }
    await Promise.all([
      sdk.trigger("mem::relate", { sourceId: "mem_a", targetId: "mem_b", type: "related" }),
      sdk.trigger("mem::relate", { sourceId: "mem_a", targetId: "mem_c", type: "related" }),
    ]);
    const a = await env.kv.get<Memory>(MEMORIES, "mem_a");
    expect([...(a!.relatedIds ?? [])].sort()).toEqual(["mem_b", "mem_c"]);
  });

  it("a relate that read a Memory before evolve does not mark the superseded version latest", async () => {
    await env.kv.set(MEMORIES, "mem_a", makeMemory({ id: "mem_a", content: "alpha record" }));
    await env.kv.set(MEMORIES, "mem_b", makeMemory({ id: "mem_b", content: "beta record" }));
    const gate = env.pauseNextSet(MEMORIES, "mem_a");
    const relate = sdk.trigger("mem::relate", {
      sourceId: "mem_a",
      targetId: "mem_b",
      type: "related",
    });
    await gate.hit;
    const evolve = sdk.trigger("mem::evolve", { memoryId: "mem_a", newContent: "alpha record v2" });
    await tick();
    gate.release();
    await Promise.all([relate, evolve]);
    const a = await env.kv.get<Memory>(MEMORIES, "mem_a");
    expect(a!.isLatest).toBe(false);
  });
});
