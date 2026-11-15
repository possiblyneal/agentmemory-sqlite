import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import {
  OBSERVE_RETRY_INTERVAL_MS,
  unstoredOnFullDisk,
} from "../src/functions/observe-retry.js";
import { resetCaptureForTests } from "../src/telemetry/capture.js";
import { DedupMap } from "../src/functions/dedup.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const T0 = new Date("2026-11-15T10:00:00.000Z");

function observeRequest(n: number, overrides: Record<string, unknown> = {}) {
  return {
    body: {
      hookType: "post_tool_use",
      sessionId: "ses-capture",
      project: "p",
      cwd: "/p",
      timestamp: `2026-11-15T10:00:${String(n).padStart(2, "0")}Z`,
      data: { n },
      ...overrides,
    },
  };
}

describe("/health capture", () => {
  let sdk: ReturnType<typeof mockSdk>;

  const capture = async () => {
    const res = (await sdk.fns.get("api::health")!({})) as {
      body: { capture: unknown };
    };
    return res.body.capture;
  };
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetCaptureForTests();
    sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    registerObserveFunction(sdk as never, kv as never, new DedupMap());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null for all three before the first Observation since boot", async () => {
    expect(await capture()).toEqual({
      lastArrivalAt: null,
      lastStoredAt: null,
      oldestPendingAt: null,
    });
  });

  it("stamps arrival and stored when an Observation is accepted and stored", async () => {
    const res = (await sdk.fns.get("api::observe")!(observeRequest(1))) as {
      status_code: number;
    };
    expect(res.status_code).toBe(201);
    expect(await capture()).toEqual({
      lastArrivalAt: "2026-11-15T10:00:00.000Z",
      lastStoredAt: "2026-11-15T10:00:00.000Z",
      oldestPendingAt: null,
    });
  });

  it("stamps arrival but not stored while a request is stuck before its row write", async () => {
    sdk.registerFunction("mem::observe", () => new Promise(() => {}));
    void sdk.fns.get("api::observe")!(observeRequest(1));
    await advance(0);
    expect(await capture()).toEqual({
      lastArrivalAt: "2026-11-15T10:00:00.000Z",
      lastStoredAt: null,
      oldestPendingAt: "2026-11-15T10:00:00.000Z",
    });
  });

  it("keeps a stuck Session's arrival as oldest pending while other Sessions store", async () => {
    const real = sdk.fns.get("mem::observe")!;
    sdk.registerFunction("mem::observe", (payload: { sessionId: string }) =>
      payload.sessionId === "ses-stuck" ? new Promise(() => {}) : real(payload),
    );
    void sdk.fns.get("api::observe")!(
      observeRequest(1, { sessionId: "ses-stuck" }),
    );
    await advance(60_000);
    await sdk.fns.get("api::observe")!(observeRequest(2));
    expect(await capture()).toEqual({
      lastArrivalAt: "2026-11-15T10:01:00.000Z",
      lastStoredAt: "2026-11-15T10:01:00.000Z",
      oldestPendingAt: "2026-11-15T10:00:00.000Z",
    });
  });

  it("settles a duplicate Observation that is never stored", async () => {
    await sdk.fns.get("api::observe")!(observeRequest(1));
    await advance(60_000);
    const res = (await sdk.fns.get("api::observe")!(observeRequest(1))) as {
      body: { deduplicated?: boolean };
    };
    expect(res.body.deduplicated).toBe(true);
    expect(await capture()).toEqual({
      lastArrivalAt: "2026-11-15T10:01:00.000Z",
      lastStoredAt: "2026-11-15T10:00:00.000Z",
      oldestPendingAt: null,
    });
  });

  it("settles an Observation whose handling fails with an error other than a full disk", async () => {
    sdk.registerFunction("mem::observe", async () => {
      throw new Error("boom");
    });
    await expect(
      sdk.fns.get("api::observe")!(observeRequest(1)),
    ).rejects.toThrow("boom");
    expect(
      ((await capture()) as { oldestPendingAt: unknown }).oldestPendingAt,
    ).toBeNull();
  });

  it("sets neither for a request rejected with 400", async () => {
    const res = (await sdk.fns.get("api::observe")!(
      observeRequest(1, { sessionId: "" }),
    )) as {
      status_code: number;
    };
    expect(res.status_code).toBe(400);
    expect(await capture()).toEqual({
      lastArrivalAt: null,
      lastStoredAt: null,
      oldestPendingAt: null,
    });
  });

  it("stamps stored when the full-disk queue replays an Observation after arrival", async () => {
    let diskFull = true;
    const real = sdk.fns.get("mem::observe")!;
    sdk.registerFunction("mem::observe", async (payload) => {
      if (diskFull) throw unstoredOnFullDisk();
      return real(payload);
    });

    const res = (await sdk.fns.get("api::observe")!(observeRequest(1))) as {
      status_code: number;
    };
    expect(res.status_code).toBe(202);
    expect(await capture()).toEqual({
      lastArrivalAt: "2026-11-15T10:00:00.000Z",
      lastStoredAt: null,
      oldestPendingAt: "2026-11-15T10:00:00.000Z",
    });

    diskFull = false;
    await advance(OBSERVE_RETRY_INTERVAL_MS);
    expect(await capture()).toEqual({
      lastArrivalAt: "2026-11-15T10:00:00.000Z",
      lastStoredAt: "2026-11-15T10:00:30.000Z",
      oldestPendingAt: null,
    });
  });
});
