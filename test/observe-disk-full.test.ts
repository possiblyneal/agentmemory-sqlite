import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import {
  OBSERVE_RETRY_CAPACITY_BYTES,
  OBSERVE_RETRY_INTERVAL_MS,
  isUnstoredOnFullDisk,
  unstoredOnFullDisk,
} from "../src/functions/observe-retry.js";
import { getImageRefCount } from "../src/functions/image-refs.js";
import { KV } from "../src/state/schema.js";
import { deleteImage } from "../src/utils/image-store.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { logger } from "../src/logger.js";

const DISK_FULL = "database or disk is full";

function observeRequest(n: number, data: Record<string, unknown> = { n }) {
  return {
    body: {
      hookType: "post_tool_use",
      sessionId: "ses-1",
      project: "p",
      cwd: "/p",
      timestamp: `2026-10-04T11:20:${String(n).padStart(2, "0")}Z`,
      data,
    },
  };
}

describe("api::observe on a full disk", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let diskFull: boolean;
  let stored: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sdk = mockSdk({ looseTrigger: true });
    registerApiTriggers(sdk as never, mockKV() as never);
    diskFull = true;
    stored = [];
    sdk.registerFunction("mem::observe", async (payload) => {
      if (diskFull) throw unstoredOnFullDisk();
      const { n } = (payload as { data: { n: number } }).data;
      stored.push(n);
      return { observationId: `obs-${n}` };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const observe = (n: number) => sdk.fns.get("api::observe")!(observeRequest(n));

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

  it("stores Observations that arrive after the disk frees behind the queued ones", async () => {
    await observe(1);
    diskFull = false;
    expect((await observe(2)).status_code).toBe(202);
    await vi.advanceTimersByTimeAsync(0);
    expect(stored).toEqual([1, 2]);
    expect((await observe(3)).status_code).toBe(201);
    expect(stored).toEqual([1, 2, 3]);
  });

  it("logs when the queue starts and how many it held when it drains", async () => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();
    for (const n of [1, 2]) await observe(n);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    diskFull = false;
    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "Observation queue drained after a full disk",
      { queued: 2 },
    );
  });

  it("drops an Observation past the byte cap rather than storing it ahead of the queue", async () => {
    const padding = "x".repeat(4 * 1024 * 1024);
    const fits = Math.floor(OBSERVE_RETRY_CAPACITY_BYTES / (padding.length + 1024));
    const observeLarge = (n: number) =>
      sdk.fns.get("api::observe")!(observeRequest(n, { n, padding }));
    for (let n = 0; n < fits; n++) {
      expect((await observeLarge(n)).status_code).toBe(202);
    }
    diskFull = false;
    await expect(observeLarge(fits)).rejects.toThrow("at its cap");
    expect(stored).toEqual([]);

    diskFull = false;
    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toHaveLength(fits);
  });

  it("still fails an Observation for any error other than a full disk", async () => {
    sdk.registerFunction("mem::observe", async () => {
      throw new Error("boom");
    });
    await expect(observe(1)).rejects.toThrow("boom");
  });

  it("does not queue an Observation whose row was stored before the disk filled", async () => {
    sdk.registerFunction("mem::observe", async () => {
      throw new Error(DISK_FULL);
    });
    await expect(observe(1)).rejects.toThrow(DISK_FULL);
  });
});

describe("mem::observe on a full disk", () => {
  function failingKV(failScope: (scope: string) => boolean) {
    const kv = mockKV();
    const set = kv.set;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (failScope(scope)) throw new Error(DISK_FULL);
      return set(scope, key, data);
    };
    return kv;
  }

  async function observeWith(kv: ReturnType<typeof mockKV>) {
    const sdk = mockSdk({ looseTrigger: true });
    registerObserveFunction(sdk as never, kv as never);
    return sdk.trigger({
      function_id: "mem::observe",
      payload: observeRequest(1).body,
    });
  }

  const imageRequest = (n: number, image: string) =>
    observeRequest(n, { tool_name: "screenshot", tool_output: { image_data: image } }).body;
  const uniqueImage = () =>
    "data:image/png;base64," + Buffer.from(`disk-full-${process.pid}-${Math.random()}`).toString("base64");
  const savedImages: string[] = [];

  afterEach(async () => {
    for (const filePath of savedImages.splice(0)) await deleteImage(filePath);
  });

  it("deletes a newly written image when its ref cannot be stored", async () => {
    const kv = failingKV((scope) => scope === KV.imageRefs);
    const sdk = mockSdk({ looseTrigger: true });
    registerObserveFunction(sdk as never, kv as never);
    const deltas: number[] = [];
    sdk.registerFunction("mem::disk-size-delta", async (p) => {
      deltas.push((p as { deltaBytes: number }).deltaBytes);
    });

    const err = await sdk
      .trigger({ function_id: "mem::observe", payload: imageRequest(1, uniqueImage()) })
      .catch((e: unknown) => e);

    expect(isUnstoredOnFullDisk(err)).toBe(true);
    expect(deltas).toHaveLength(2);
    expect(deltas[0]! + deltas[1]!).toBe(0);
  });

  it("retries a failed image ref rollback once the disk has room", async () => {
    let full = true;
    const kv = failingKV((scope) => full && scope.startsWith("mem:obs:"));
    const del = kv.delete;
    kv.delete = async (scope: string, key: string) => {
      if (full) throw new Error(DISK_FULL);
      return del(scope, key);
    };
    const sdk = mockSdk({ looseTrigger: true });
    registerObserveFunction(sdk as never, kv as never);
    const image = uniqueImage();

    await expect(
      sdk.trigger({ function_id: "mem::observe", payload: imageRequest(1, image) }),
    ).rejects.toThrow(DISK_FULL);
    const [filePath] = [...(kv.store.get(KV.imageRefs)?.keys() ?? [])];
    savedImages.push(filePath!);
    expect(await getImageRefCount(kv as never, filePath!)).toBe(1);

    full = false;
    await sdk.trigger({ function_id: "mem::observe", payload: observeRequest(2).body });

    expect(await getImageRefCount(kv as never, filePath!)).toBe(0);
    expect(existsSync(filePath!)).toBe(false);
  });

  it("marks the Observation unstored when its row write fails", async () => {
    const kv = failingKV((scope) => scope.startsWith("mem:obs:"));
    const err = await observeWith(kv).catch((e: unknown) => e);
    expect(isUnstoredOnFullDisk(err)).toBe(true);
  });

  it("does not mark it unstored when a later write fails", async () => {
    const kv = failingKV((scope) => scope === "mem:sessions");
    const err = await observeWith(kv).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUnstoredOnFullDisk(err)).toBe(false);
  });
});
