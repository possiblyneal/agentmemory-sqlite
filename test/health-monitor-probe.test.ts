import { describe, it, expect, afterEach, vi } from "vitest";
import { availableParallelism } from "node:os";
import { registerHealthMonitor } from "../src/health/monitor.js";
import { KV } from "../src/state/schema.js";
import type { HealthSnapshot } from "../src/types.js";

type ProbeBehaviour = "ok" | "reject" | "hang";

function mockKV(probe: ProbeBehaviour) {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (key === "_probe" && probe === "reject") throw new Error("disk full");
      if (key === "_probe" && probe === "hang") return new Promise<T>(() => {});
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  return {
    registerFunction: () => {},
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

async function latestAfterFirstSample(kv: ReturnType<typeof mockKV>, advanceMs = 0) {
  const monitor = registerHealthMonitor(mockSdk() as never, kv as never);
  if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
  await vi.waitFor(async () => {
    expect(await kv.get(KV.health, "latest")).not.toBeNull();
  });
  monitor.stop();
  return (await kv.get<HealthSnapshot>(KV.health, "latest"))!;
}

describe("health monitor store probe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports ok when the probe write reads back, and clears its timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const snapshot = await latestAfterFirstSample(mockKV("ok"));
    expect(snapshot.kvConnectivity.status).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports kv_probe_failed when the probe write fails", async () => {
    const snapshot = await latestAfterFirstSample(mockKV("reject"));
    expect(snapshot.kvConnectivity).toMatchObject({ status: "error", error: "kv_probe_failed" });
  });

  it("reports kv_probe_failed when the probe write never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const snapshot = await latestAfterFirstSample(mockKV("hang"), 5000);
    expect(snapshot.kvConnectivity).toMatchObject({ status: "error", error: "kv_probe_failed" });
  });
});

describe("health monitor cpu", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports cpu against total core capacity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let user = 0;
    vi.spyOn(process, "cpuUsage").mockImplementation(() => ({ user, system: 0 }));
    const kv = mockKV("ok");
    const monitor = registerHealthMonitor(mockSdk() as never, kv as never);
    await vi.waitFor(async () => {
      expect(await kv.get(KV.health, "latest")).not.toBeNull();
    });
    user = 30_000_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => {
      expect((await kv.get<HealthSnapshot>(KV.health, "latest"))!.cpu.percent).toBeCloseTo(100 / availableParallelism(), 1);
    });
    monitor.stop();
  });
});
