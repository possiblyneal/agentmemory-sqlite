import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { DedupMap } from "../src/functions/dedup.js";
import {
  OBSERVE_RETRY_CAPACITY_BYTES,
  OBSERVE_RETRY_INTERVAL_MS,
  isUnstored,
  retryableWriteCause,
  unstored,
  unstoredOnFullDisk,
} from "../src/functions/observe-retry.js";
import { SqliteState } from "../src/engine/inproc/state.js";
import { getImageRefCount } from "../src/functions/image-refs.js";
import { KV } from "../src/state/schema.js";
import { deleteImage } from "../src/utils/image-store.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { logger } from "../src/logger.js";

const DISK_FULL = "database or disk is full";
const LOCKED = "database is locked";

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

describe("api::observe when a row write fails", () => {
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

  it("rejects capture when configured literal rules cannot be read", async () => {
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = "/nonexistent/synthetic-rules.json";
    try {
      const response = await observe(1);
      expect(response.status_code).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain("synthetic-rules");
    } finally {
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
    }
  });

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

  it("admits concurrent captures in order while a rules read is delayed", async () => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "redaction-order-"));
    const path = join(dir, "rules.json");
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    const original = fsPromises.open;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    writeFileSync(path, "[]");
    try {
      process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = path;
      await observe(1);
      fsPromises.open = (async (...args: Parameters<typeof original>) => {
        if (++calls === 1) await gate;
        return original(...args);
      }) as typeof original;
      syncBuiltinESMExports();
      const second = observe(2);
      const third = observe(3);
      await Promise.resolve();
      release();
      await Promise.all([second, third]);
      expect(calls).toBe(1);
      fsPromises.open = original;
      syncBuiltinESMExports();
      diskFull = false;
      await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
      expect(stored).toEqual([1, 2, 3]);
    } finally {
      release();
      fsPromises.open = original;
      syncBuiltinESMExports();
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
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
      "Observation queue drained after a failed write",
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

    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toHaveLength(fits);
  });

  it("queues an Observation whose row write hit a lock and stores it once the lock clears", async () => {
    let locked = true;
    sdk.registerFunction("mem::observe", async (payload) => {
      if (locked) throw unstored(LOCKED);
      stored.push((payload as { data: { n: number } }).data.n);
      return { observationId: "obs" };
    });
    expect((await observe(1)).status_code).toBe(202);
    locked = false;
    await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
    expect(stored).toEqual([1]);
  });

  it("still fails an Observation for an error that does not clear on its own", async () => {
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

describe("mem::observe literal redaction", () => {
  it("retains colliding fields, existing secret scrubbing, and original-input deduplication", async () => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "redaction-test-"));
    const path = join(dir, "rules.json");
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    writeFileSync(path, JSON.stringify(["password", "private", "SYNTHETIC-A", "SYNTHETIC-B"]));
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = path;
    try {
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      const captured: Array<{ raw: Record<string, unknown> }> = [];
      sdk.registerFunction("stream::send", async (payload) => {
        captured.push((payload as { data: { observation: { raw: Record<string, unknown> } } }).data.observation);
      });
      registerObserveFunction(sdk as never, kv as never, new DedupMap());
      for (const value of ["SYNTHETIC-A", "SYNTHETIC-B"]) {
        await sdk.trigger({ function_id: "mem::observe", payload: observeRequest(1, {
          tool_name: "Edit", tool_input: value, password: "SYNTHETIC-SECRET-VALUE",
          note: "<private>SYNTHETIC-PRIVATE-VALUE</private>",
          "key-SYNTHETIC-A": "first", "key-SYNTHETIC-B": "second",
        }).body });
      }
      expect(captured).toHaveLength(2);
      const raw = captured[0].raw;
      expect(JSON.stringify(raw)).not.toContain("SYNTHETIC-SECRET-VALUE");
      expect(JSON.stringify(raw)).not.toContain("SYNTHETIC-PRIVATE-VALUE");
      expect(Object.values(raw)).toContain("first");
      expect(Object.values(raw)).toContain("second");
    } finally {
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["padded", "unpadded", "raw-unpadded", "whitespace", "url-safe"])("redacts image-prefixed text while retaining an encoded image (%s)", async (encoding) => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "redaction-test-"));
    const path = join(dir, "rules.json");
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    const padded = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==";
    const image = encoding === "unpadded" ? padded.replace(/=+$/, "")
      : encoding === "raw-unpadded" ? padded.slice(padded.indexOf(",") + 1).replace(/=+$/, "")
      : encoding === "whitespace" ? padded.replace("AAAANSUh", "AAAA \nNSUh")
      : encoding === "url-safe" ? padded.replaceAll("/", "_").replace("data:image_png", "data:image/png")
      : padded;
    writeFileSync(path, JSON.stringify(["SYNTHETIC-IDENTIFIER", "iVBORw0KGgo"]));
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = path;
    try {
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      let captured: { raw: { tool_input: { text: string; screenshot: string } } } | undefined;
      sdk.registerFunction("stream::send", async (payload) => {
        captured = (payload as { data: { observation: typeof captured } }).data.observation;
      });
      registerObserveFunction(sdk as never, kv as never);
      await sdk.trigger({ function_id: "mem::observe", payload: observeRequest(1, {
        tool_name: "Edit", tool_input: { text: "data:image/png;base64,SYNTHETIC-IDENTIFIER text", screenshot: image },
        image_path: join(dir, "image.png"),
      }).body });
      expect(captured?.raw.tool_input.text).not.toContain("SYNTHETIC-IDENTIFIER");
      expect(captured?.raw.tool_input.screenshot).toBe(image);
    } finally {
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid rules without persisting an Observation", async () => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "redaction-test-"));
    const path = join(dir, "rules.json");
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    writeFileSync(path, JSON.stringify(["SYNTHETIC-IDENTIFIER", ""]));
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = path;
    try {
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      registerObserveFunction(sdk as never, kv as never);
      await expect(sdk.trigger({ function_id: "mem::observe", payload: observeRequest(1).body }))
        .rejects.toThrow("Observation redaction rules are invalid or unreadable");
      expect(kv.store.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts a queued Observation before the retry persists it", async () => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "redaction-test-"));
    const path = join(dir, "rules.json");
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    writeFileSync(path, JSON.stringify(["SYNTHETIC-IDENTIFIER"]));
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = path;
    vi.useFakeTimers();
    try {
      const kv = mockKV();
      const set = kv.set;
      let locked = true;
      kv.set = async (scope, key, data) => {
        if (locked && scope === KV.observations("ses-1")) throw new Error(LOCKED);
        return set(scope, key, data);
      };
      const sdk = mockSdk({ looseTrigger: true });
      registerObserveFunction(sdk as never, kv as never);
      const observe = sdk.fns.get("mem::observe")!;
      let rejectedRetry = false;
      sdk.registerFunction("mem::observe", async (payload) => {
        try { return await observe(payload); }
        catch (err) {
          if (err instanceof Error && err.message.includes("redaction rules")) rejectedRetry = true;
          throw err;
        }
      });
      registerApiTriggers(sdk as never, kv as never);
      const result = await sdk.fns.get("api::observe")!(observeRequest(1, { tool_name: "Edit", tool_input: "SYNTHETIC-IDENTIFIER" }));
      expect(result.status_code).toBe(202);
      locked = false;
      writeFileSync(path, "invalid rules");
      expect((await sdk.fns.get("api::observe")!(observeRequest(2))).status_code).toBe(503);
      await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
      await vi.waitFor(() => expect(rejectedRetry).toBe(true));
      expect(kv.store.get(KV.observations("ses-1"))?.size ?? 0).toBe(0);
      writeFileSync(path, JSON.stringify(["SYNTHETIC-IDENTIFIER"]));
      await vi.advanceTimersByTimeAsync(OBSERVE_RETRY_INTERVAL_MS);
      await vi.waitFor(() => expect(kv.store.get(KV.observations("ses-1"))?.size).toBe(1));
      const stored = JSON.stringify([...kv.store.entries()].map(([key, rows]) => [key, [...rows.values()]]));
      expect(stored).toContain("[REDACTED]");
      expect(stored).not.toContain("SYNTHETIC-IDENTIFIER");
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["false", "true"])("redacts payload before storage and compression with auto-compress %s", async (autoCompress) => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "redaction-test-"));
    const path = join(dir, "rules.json");
    const previousRules = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    const previousCompress = process.env.AGENTMEMORY_AUTO_COMPRESS;
    writeFileSync(path, JSON.stringify(["SYNTHETIC-IDENTIFIER", "alpha beta", "beta gamma", "quoted\"\\literal\nline"]));
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = path;
    process.env.AGENTMEMORY_AUTO_COMPRESS = autoCompress;
    try {
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      const sent: unknown[] = [];
      sdk.registerFunction("mem::compress-enqueue", async (payload) => { sent.push(payload); });
      registerObserveFunction(sdk as never, kv as never);
      await sdk.trigger({ function_id: "mem::observe", payload: observeRequest(1, {
        tool_name: "Edit", tool_input: { text: "SYNTHETIC-IDENTIFIER", other: "synthetic-identifier" },
        tool_output: "SYNTHETIC-IDENTIFIER alpha beta gamma quoted\"\\literal\nline",
      }).body });
      const allStored = JSON.stringify([...kv.store.entries()].map(([key, value]) => [key, [...value.values()]]));
      expect(allStored).not.toContain("SYNTHETIC-IDENTIFIER");
      expect(allStored).not.toContain("alpha");
      expect(allStored).not.toContain("gamma");
      expect(allStored).not.toContain("quoted");
      expect(allStored).toContain("synthetic-identifier");
      expect(allStored).toContain("[REDACTED]");
      if (autoCompress === "true") {
        expect(sent).toHaveLength(1);
        expect(JSON.stringify(sent)).not.toContain("SYNTHETIC-IDENTIFIER");
      }
    } finally {
      if (previousRules === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previousRules;
      if (previousCompress === undefined) delete process.env.AGENTMEMORY_AUTO_COMPRESS;
      else process.env.AGENTMEMORY_AUTO_COMPRESS = previousCompress;
      rmSync(dir, { recursive: true, force: true });
    }
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

    expect(isUnstored(err)).toBe(true);
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
    expect(isUnstored(err)).toBe(true);
  });

  it("does not mark it unstored when a later write fails", async () => {
    const kv = failingKV((scope) => scope === "mem:sessions");
    const err = await observeWith(kv).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUnstored(err)).toBe(false);
  });
});

describe("mem::observe on a locked database", () => {
  function lockedKV(failScope: (scope: string) => boolean) {
    const kv = mockKV();
    const set = kv.set;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (failScope(scope)) throw new Error(LOCKED);
      return set(scope, key, data);
    };
    return kv;
  }

  async function observeWith(kv: ReturnType<typeof mockKV>) {
    const sdk = mockSdk({ looseTrigger: true });
    registerObserveFunction(sdk as never, kv as never);
    return sdk.trigger({ function_id: "mem::observe", payload: observeRequest(1).body });
  }

  it("marks the Observation unstored when its row write hits a lock", async () => {
    const err = await observeWith(lockedKV((scope) => scope.startsWith("mem:obs:"))).catch((e: unknown) => e);
    expect(isUnstored(err)).toBe(true);
  });

  it("does not mark it unstored when a later write hits a lock", async () => {
    const err = await observeWith(lockedKV((scope) => scope === "mem:sessions")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUnstored(err)).toBe(false);
  });

  // Pins the matched text to what node:sqlite actually throws when another
  // connection holds the write lock.
  it("recognises node:sqlite's own error while another connection holds the write lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "observe-locked-"));
    const path = join(dir, "state.db");
    const state = new SqliteState(path);
    const other = new DatabaseSync(path);
    try {
      other.exec("BEGIN IMMEDIATE");
      let err: unknown;
      try {
        state.set("mem:obs:ses-1", "obs-1", { n: 1 });
      } catch (e) {
        err = e;
      }
      expect(retryableWriteCause(err)).toBe(LOCKED);
      other.exec("COMMIT");
      expect(() => state.set("mem:obs:ses-1", "obs-1", { n: 1 })).not.toThrow();
    } finally {
      other.close();
      state.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
