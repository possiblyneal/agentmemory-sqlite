import { describe, it, expect } from "vitest";
import { MetricsStore } from "../src/eval/metrics-store.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const value = structuredClone((store.get(scope)?.get(key) as T) ?? null);
      await tick();
      return value;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(data));
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

describe("MetricsStore.record", () => {
  it("counts every concurrent first record for a function (upstream PR #1291)", async () => {
    const kv = mockKV();
    const store = new MetricsStore(kv as never);

    await Promise.all([
      store.record("mem::compress", 10, true),
      store.record("mem::compress", 20, false),
      store.record("mem::compress", 30, true),
    ]);

    const persisted = await new MetricsStore(kv as never).get("mem::compress");
    expect(persisted).toMatchObject({ totalCalls: 3, successCount: 2, failureCount: 1, avgLatencyMs: 20 });
  });
});
