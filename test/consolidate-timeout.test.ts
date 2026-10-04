import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Memory, MemoryProvider, Session } from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeMockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : (idOrInput as { payload: unknown }).payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function registered: ${id}`);
      return fn(payload);
    },
  };
}

function makeProvider(title = "synthesized memory title"): MemoryProvider {
  return {
    name: "mock",
    compress: vi.fn().mockResolvedValue(
      `<memory>
        <type>pattern</type>
        <title>${title}</title>
        <content>synthesized content about the concept</content>
        <concepts><concept>auth</concept></concepts>
        <files><file>src/auth.ts</file></files>
        <strength>7</strength>
      </memory>`,
    ),
    embed: vi.fn().mockResolvedValue(new Float32Array(384)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 384,
    compressionModel: "mock-model",
  };
}

function makeSession(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: `/srv/${project}`,
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: 5,
  };
}

function makeObs(id: string, sessionId: string, concept: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "decision",
    title: `${concept} observation ${id}`,
    facts: [`fact about ${concept}`],
    narrative: `detailed narrative about ${concept} pattern usage`,
    concepts: [concept],
    files: ["src/auth.ts"],
    importance: 8,
  };
}

function makeExistingMemory(id: string, title: string, project?: string): Memory {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "pattern",
    title,
    content: "existing content",
    concepts: ["auth"],
    files: ["src/auth.ts"],
    sessionIds: [],
    strength: 6,
    version: 1,
    isLatest: true,
    ...(project !== undefined && { project }),
  };
}


const memoryXml = (title: string) => `<memory>
  <type>pattern</type><title>${title}</title>
  <content>synthesized content</content>
  <concepts><concept>x</concept></concepts>
  <files><file>src/a.ts</file></files><strength>7</strength>
</memory>`;

async function seed(kv: ReturnType<typeof makeMockKV>, concepts: string[]) {
  const session = makeSession("sess_t", "proj");
  await kv.set(KV.sessions, session.id, session);
  for (const concept of concepts) {
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_${concept}_${i}`,
        makeObs(`obs_${concept}_${i}`, session.id, concept),
      );
    }
  }
}

describe("mem::consolidate — LLM call timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a slow provider call outlive 30s instead of clamping it", async () => {
    vi.useFakeTimers();
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    await seed(kv, ["auth"]);
    const provider = makeProvider();
    provider.compress = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(memoryXml("slow ok")), 45_000)),
    );

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    const run = sdk.trigger("mem::consolidate", { minObservations: 1 });
    await vi.advanceTimersByTimeAsync(45_000);
    const result = (await run) as { consolidated: number };

    expect(result.consolidated).toBe(1);
  });

  it("fails one concept cleanly when the provider times out and still consolidates the rest", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    await seed(kv, ["auth", "db"]);
    const provider = makeProvider();
    provider.compress = vi
      .fn()
      .mockRejectedValueOnce(new Error("request timed out"))
      .mockResolvedValue(memoryXml("second ok"));

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    const result = (await sdk.trigger("mem::consolidate", { minObservations: 1 })) as {
      consolidated: number;
    };

    expect(result.consolidated).toBe(1);
    expect(provider.compress).toHaveBeenCalledTimes(2);
  });
});
