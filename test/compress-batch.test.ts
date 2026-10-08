import { describe, it, expect, vi, afterEach } from "vitest";
import type { CompressedObservation, RawObservation } from "../src/types.js";
import { registerCompressFunction } from "../src/functions/compress.js";
import {
  BATCH_IDLE_MS,
  BATCH_MAX_ITEMS,
  parkForCompression,
  registerCompressBatchFunction,
} from "../src/functions/compress-batch.js";
import { storeSyntheticCompression } from "../src/functions/observe.js";
import { COMPRESSION_BATCH_SYSTEM } from "../src/prompts/compression.js";
import { getXmlElementsById } from "../src/prompts/xml.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: string[] = [];
  return {
    triggered,
    registerFunction: (id: string, fn: Function) => {
      fns.set(id, fn);
    },
    trigger: async (input: { function_id: string; payload: unknown }) => {
      triggered.push(input.function_id);
      const fn = fns.get(input.function_id);
      return fn ? fn(input.payload) : null;
    },
  };
}

const SESSION = "ses_batch";

function raw(n: number): RawObservation {
  return {
    id: `obs_${n}`,
    sessionId: SESSION,
    timestamp: new Date().toISOString(),
    hookType: "post_tool_use",
    toolName: "Edit",
    toolInput: { file_path: `src/file${n}.ts`, old_string: "a", new_string: "b" },
    toolOutput: "ok",
  };
}

function fields(title: string): string {
  return `<type>file_edit</type>
<title>${title}</title>
<facts><fact>Changed a to b</fact></facts>
<narrative>The agent edited a file to change a to b.</narrative>
<concepts><concept>refactor</concept></concepts>
<files><file>src/x.ts</file></files>
<importance>5</importance>`;
}

function block(id: string, title: string): string {
  return `<observation id="${id}">\n${fields(title)}\n</observation>`;
}

// What observe does on the llm-batch path: park the raw, then store the
// synthetic record that search serves until the batch lands.
async function observe(kv: ReturnType<typeof mockKV>, r: RawObservation) {
  await parkForCompression(kv as never, r);
  await storeSyntheticCompression(kv as never, r);
}

function setup(compress: (system: string, prompt: string) => Promise<string>) {
  const sdk = mockSdk();
  const kv = mockKV();
  const provider = { compress: vi.fn(compress) };
  registerCompressFunction(sdk as never, kv as never, provider as never);
  registerCompressBatchFunction(sdk as never, kv as never, provider as never);
  const enqueue = (r: RawObservation) =>
    sdk.trigger({ function_id: "mem::compress-enqueue", payload: { observationId: r.id, sessionId: r.sessionId, raw: r } });
  const flush = () => sdk.trigger({ function_id: "mem::compress-flush", payload: { sessionId: SESSION } });
  const stored = (id: string) => kv.get<CompressedObservation>(`mem:obs:${SESSION}`, id);
  const pending = (id: string) => kv.get<{ reason: string; attempts: number }>("mem:compress-pending", id);
  return { sdk, kv, provider, enqueue, flush, stored, pending };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getXmlElementsById", () => {
  it("keys each block by its id and ignores blocks without one", () => {
    const xml = `${block("a", "A")}\n<observation>${fields("anon")}</observation>\n<observation id = " b ">x</observation>`;
    const blocks = getXmlElementsById(xml, "observation");
    expect([...blocks.keys()]).toEqual(["a", "b"]);
    expect(blocks.get("a")).toContain("<title>A</title>");
  });
});

describe("mem::compress-enqueue batching", () => {
  it("compresses a full batch in one call and upgrades every synthetic record", async () => {
    const t = setup(async (system, prompt) => {
      expect(system).toBe(COMPRESSION_BATCH_SYSTEM);
      const ids = [...prompt.matchAll(/=== Observation (\S+) ===/g)].map((m) => m[1]);
      return ids.map((id) => block(id, `Edited ${id}`)).join("\n");
    });
    const raws = Array.from({ length: BATCH_MAX_ITEMS }, (_, i) => raw(i));
    for (const r of raws) await observe(t.kv, r);

    for (const r of raws) await t.enqueue(r);

    expect(t.provider.compress).toHaveBeenCalledTimes(1);
    for (const r of raws) {
      const obs = await t.stored(r.id);
      expect(obs?.title).toBe(`Edited ${r.id}`);
      expect(obs?.confidence).not.toBe(0.3);
      expect(await t.pending(r.id)).toBeNull();
    }
    expect(t.sdk.triggered).not.toContain("mem::compress");
  });

  it("keeps the synthetic record visible until the batch lands", async () => {
    vi.useFakeTimers();
    const t = setup(async (_s, prompt) =>
      [...prompt.matchAll(/=== Observation (\S+) ===/g)].map((m) => block(m[1], "Upgraded")).join("\n"),
    );
    await observe(t.kv, raw(1));
    await observe(t.kv, raw(2));
    await t.enqueue(raw(1));
    await t.enqueue(raw(2));

    expect(t.provider.compress).not.toHaveBeenCalled();
    expect((await t.stored("obs_1"))?.confidence).toBe(0.3);
    expect((await t.pending("obs_1"))?.reason).toBe("queued");

    await vi.advanceTimersByTimeAsync(BATCH_IDLE_MS);

    expect(t.provider.compress).toHaveBeenCalledTimes(1);
    expect((await t.stored("obs_1"))?.title).toBe("Upgraded");
    expect((await t.stored("obs_2"))?.title).toBe("Upgraded");
  });

  it("sends an item missing or invalid in the reply through mem::compress alone", async () => {
    const t = setup(async (system) =>
      system === COMPRESSION_BATCH_SYSTEM
        ? `${block("obs_1", "From batch")}\n<observation id="obs_2"><title>no type</title></observation>`
        : `<observation>${fields("From single")}</observation>`,
    );
    for (const n of [1, 2, 3]) {
      await observe(t.kv, raw(n));
      await t.enqueue(raw(n));
    }
    await t.flush();

    expect((await t.stored("obs_1"))?.title).toBe("From batch");
    expect((await t.stored("obs_2"))?.title).toBe("From single");
    expect((await t.stored("obs_3"))?.title).toBe("From single");
    expect(t.sdk.triggered.filter((id) => id === "mem::compress")).toHaveLength(2);
    for (const n of [1, 2, 3]) expect(await t.pending(`obs_${n}`)).toBeNull();
  });

  it("degrades every item when the call fails, leaving it for the orphan sweep", async () => {
    const t = setup(async () => {
      throw new Error("broker down");
    });
    for (const n of [1, 2]) {
      await observe(t.kv, raw(n));
      await t.enqueue(raw(n));
    }
    await t.flush();

    for (const n of [1, 2]) {
      expect((await t.stored(`obs_${n}`))?.confidence).toBe(0.3);
      const parked = await t.pending(`obs_${n}`);
      expect(parked?.reason).toBe("compression_failed");
      expect(parked?.attempts).toBe(1);
    }
    expect(t.sdk.triggered).not.toContain("mem::compress");
  });

  it("skips an Observation evicted while it waited", async () => {
    const t = setup(async () => `<observation>${fields("Single")}</observation>`);
    for (const n of [1, 2]) {
      await observe(t.kv, raw(n));
      await t.enqueue(raw(n));
    }
    await t.kv.delete(`mem:obs:${SESSION}`, "obs_2");
    await t.flush();

    expect(await t.stored("obs_2")).toBeNull();
    expect(await t.pending("obs_2")).toBeNull();
    expect((await t.stored("obs_1"))?.title).toBe("Single");
  });
});

describe("mem::compress-resume", () => {
  it("re-queues what a restart left waiting and leaves failed entries alone", async () => {
    const kv = mockKV();
    for (const n of [1, 2]) await observe(kv, raw(n));
    await kv.set("mem:compress-pending", "obs_9", {
      observationId: "obs_9",
      sessionId: SESSION,
      raw: raw(9),
      reason: "compression_failed",
      attempts: 2,
    });

    // A fresh registrar stands in for the restarted daemon: its queue is empty.
    const sdk = mockSdk();
    const provider = {
      compress: vi.fn(async (_s: string, prompt: string) =>
        [...prompt.matchAll(/=== Observation (\S+) ===/g)].map((m) => block(m[1], "Resumed")).join("\n"),
      ),
    };
    registerCompressFunction(sdk as never, kv as never, provider as never);
    registerCompressBatchFunction(sdk as never, kv as never, provider as never);

    const result = await sdk.trigger({ function_id: "mem::compress-resume", payload: {} });

    expect(result).toEqual({ resumed: 2 });
    expect(provider.compress).toHaveBeenCalledTimes(1);
    for (const n of [1, 2]) {
      expect((await kv.get<CompressedObservation>(`mem:obs:${SESSION}`, `obs_${n}`))?.title).toBe("Resumed");
      expect(await kv.get("mem:compress-pending", `obs_${n}`)).toBeNull();
    }
    expect(await kv.get("mem:compress-pending", "obs_9")).not.toBeNull();
  });
});
