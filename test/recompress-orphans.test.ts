import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerRecompressOrphansFunction, createRecompressSweep } from "../src/functions/recompress-orphans.js";
import { logger } from "../src/logger.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(s: string, key: string): Promise<T | null> =>
      (store.get(s)?.get(key) as T) ?? null,
    set: async <T>(s: string, key: string, data: T): Promise<T> => {
      if (!store.has(s)) store.set(s, new Map());
      store.get(s)!.set(key, data);
      return data;
    },
    delete: async (s: string, key: string): Promise<void> => {
      store.get(s)?.delete(key);
    },
    list: async <T>(s: string): Promise<T[]> =>
      Array.from(store.get(s)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

type Result = {
  rawOrphans: number;
  parked: number;
  quarantined: number;
  queued: number;
  recompressed?: number;
  stillFailing?: number;
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function setup(compress: (p: { observationId: string }) => Promise<unknown>) {
  const kv = mockKV();
  const sdk = mockSdk();
  const compressed: string[] = [];
  sdk.registerFunction("mem::compress", async (p: { observationId: string }) => {
    compressed.push(p.observationId);
    return compress(p);
  });
  registerRecompressOrphansFunction(sdk as never, kv as never);
  const run = (payload: object = {}) =>
    sdk.trigger({ function_id: "mem::recompress-orphans", payload }) as Promise<Result>;
  return { kv, sdk, compressed, run };
}

async function park(kv: ReturnType<typeof mockKV>, id: string, extra: object = {}) {
  await kv.set(KV.observations("ses_1"), id, { id, sessionId: "ses_1" });
  await kv.set(KV.compressPending, id, {
    observationId: id,
    sessionId: "ses_1",
    raw: { id },
    attempts: 1,
    ...extra,
  });
}

describe("mem::recompress-orphans", () => {
  it("recompresses a parked entry", async () => {
    const { kv, compressed, run } = setup(async () => ({ success: true }));
    await park(kv, "p1");
    const res = await run();
    expect(compressed).toEqual(["p1"]);
    expect(res).toMatchObject({ parked: 1, recompressed: 1, stillFailing: 0 });
  });

  it("leaves a queued entry inside the grace and takes it past it, unless the bypass covers it", async () => {
    const { kv, run } = setup(async () => ({ success: true }));
    await park(kv, "fresh", { reason: "queued", queuedAt: ago(60_000) });
    await park(kv, "stuck", { reason: "queued", queuedAt: ago(2 * 3_600_000) });
    expect((await run({ dryRun: true })).parked).toBe(1);
    const bypass = new Date(Date.now() + 1000).toISOString();
    expect((await run({ dryRun: true, graceBypassBefore: bypass })).parked).toBe(2);
  });

  it("dry run reports counts and compresses nothing", async () => {
    const { kv, compressed, run } = setup(async () => ({ success: true }));
    await park(kv, "p1");
    await park(kv, "q1", { attempts: 5 });
    const res = await run({ dryRun: true });
    expect(compressed).toEqual([]);
    expect(res).toMatchObject({ parked: 1, quarantined: 1, queued: 1 });
    expect(res.recompressed).toBeUndefined();
  });

  it("drops a parked entry whose Observation is gone instead of resurrecting it", async () => {
    const { kv, compressed, run } = setup(async () => ({ success: true }));
    await park(kv, "kept");
    await park(kv, "evicted");
    await kv.delete(KV.observations("ses_1"), "evicted");
    expect((await run({ dryRun: true })).parked).toBe(1);
    expect(await kv.get(KV.compressPending, "evicted")).not.toBeNull();
    const res = await run();
    expect(compressed).toEqual(["kept"]);
    expect(res).toMatchObject({ parked: 1, recompressed: 1 });
    expect(await kv.get(KV.compressPending, "evicted")).toBeNull();
  });

  it("skips a target evicted while the pass compresses an earlier one", async () => {
    let kv!: ReturnType<typeof mockKV>;
    const ctx = setup(async (p) => {
      if (p.observationId === "first") await kv.delete(KV.observations("ses_1"), "second");
      return { success: true };
    });
    kv = ctx.kv;
    await park(kv, "first");
    await park(kv, "second");
    const res = await ctx.run();
    expect(ctx.compressed).toEqual(["first"]);
    expect(res).toMatchObject({ recompressed: 1, stillFailing: 0 });
    expect(await kv.get(KV.compressPending, "second")).toBeNull();
  });

  it("refuses a pass while another is running, but not a dry run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { kv, compressed, run } = setup(async () => {
      await gate;
      return { success: true };
    });
    await park(kv, "p1");
    const first = run();
    expect(await run()).toMatchObject({ success: false, running: true });
    expect((await run({ dryRun: true })).parked).toBe(1);
    release();
    await first;
    expect(compressed).toEqual(["p1"]);
    expect(await run()).toMatchObject({ success: true });
  });

  it("bails out after 10 straight failures when none succeeded", async () => {
    const { kv, compressed, run } = setup(async () => ({ success: false }));
    for (let i = 0; i < 15; i++) await park(kv, `p${i}`);
    const res = await run({ limit: 15 });
    expect(compressed).toHaveLength(10);
    expect(res).toMatchObject({ recompressed: 0, stillFailing: 10 });
  });
});

describe("createRecompressSweep", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs no pass with auto-compress off", async () => {
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    const trigger = vi.fn();
    await createRecompressSweep({ trigger } as never)();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("logs a failed pass instead of throwing and runs the next one", async () => {
    const trigger = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const sweep = createRecompressSweep({ trigger } as never);
    await expect(sweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    await sweep();
    expect(trigger).toHaveBeenCalledTimes(2);
  });
});
