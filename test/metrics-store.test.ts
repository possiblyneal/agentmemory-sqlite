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

describe("MetricsStore windowed failures", () => {
  it("bounds recent outcomes, records lastFailureAt, and reads legacy records", async () => {
    const kv = mockKV();
    await kv.set("mem:metrics", "legacy", {
      functionId: "legacy", totalCalls: 5, successCount: 1, failureCount: 4,
      avgLatencyMs: 1, avgQualityScore: 0,
    });
    const store = new MetricsStore(kv as never);
    await store.record("legacy", 1, true);
    const legacy = await store.get("legacy");
    expect(legacy?.recentOutcomes).toEqual([true]);
    expect(legacy?.lastFailureAt).toBeUndefined();

    await store.record("f", 1, false);
    for (let i = 0; i < 150; i++) await store.record("f", 1, true);
    const m = await store.get("f");
    expect(m?.recentOutcomes?.length).toBe(100);
    expect(m?.recentOutcomes?.every(Boolean)).toBe(true);
    expect(m?.failureCount).toBe(1);
    expect(typeof m?.lastFailureAt).toBe("string");
  });
});
