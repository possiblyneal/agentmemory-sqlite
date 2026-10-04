import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import {
  OBSERVE_RETRY_CAPACITY,
  OBSERVE_RETRY_INTERVAL_MS,
} from "../src/functions/observe-retry.js";

const DISK_FULL = "database or disk is full";

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T) => data,
    delete: async () => {},
    list: async () => [],
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

function observeRequest(n: number) {
  return {
    body: {
      hookType: "post_tool_use",
      sessionId: "ses-1",
      project: "p",
      cwd: "/p",
      timestamp: `2026-10-04T11:20:${String(n).padStart(2, "0")}Z`,
      data: { n },
    },
  };
}

describe("api::observe on a full disk", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let diskFull: boolean;
  let stored: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never);
    diskFull = true;
    stored = [];
    sdk.registerFunction("mem::observe", async (payload: { data: { n: number } }) => {
      if (diskFull) throw new Error(DISK_FULL);
      stored.push(payload.data.n);
      return { observationId: `obs-${payload.data.n}` };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const observe = (n: number) => sdk._fns.get("api::observe")!(observeRequest(n));

  it("accepts the Observation and stores it once the disk frees", async () => {
    const res = await observe(1);
    expect(res.status_code).toBe(202);

    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toEqual([]);

    diskFull = false;
    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toEqual([1]);

    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS * 3);
    expect(stored).toEqual([1]);
  });

  it("replays queued Observations in arrival order", async () => {
    for (const n of [1, 2, 3]) await observe(n);
    diskFull = false;
    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toEqual([1, 2, 3]);
  });

  it("drops the newest Observation past capacity and keeps the queued ones", async () => {
    for (let n = 0; n < OBSERVE_RETRY_CAPACITY; n++) {
      expect((await observe(n)).status_code).toBe(202);
    }
    await expect(observe(OBSERVE_RETRY_CAPACITY)).rejects.toThrow(DISK_FULL);

    diskFull = false;
    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toHaveLength(OBSERVE_RETRY_CAPACITY);
  });

  it("still fails an Observation for any error other than a full disk", async () => {
    sdk.registerFunction("mem::observe", async () => {
      throw new Error("boom");
    });
    await expect(observe(1)).rejects.toThrow("boom");
  });
});
