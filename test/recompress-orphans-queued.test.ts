import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

const SECRET = "recompress-orphans-test-secret";

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

describe("api::recompress-orphans and the compression batch", () => {
  it("leaves a queued entry to its batch inside the grace and takes it past it", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);
    const queuedAt = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    for (const [id, at] of [["fresh", queuedAt(60_000)], ["stuck", queuedAt(2 * 60 * 60_000)]]) {
      await kv.set(KV.compressPending, id, {
        observationId: id,
        sessionId: "ses_1",
        raw: { id },
        reason: "queued",
        queuedAt: at,
        attempts: 0,
      });
    }

    const res = (await sdk._fns.get("api::recompress-orphans")!({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { dryRun: true },
    })) as { body: { parked: number } };

    expect(res.body.parked).toBe(1);
  });
});
