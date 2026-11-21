import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerLessonsFunctions, resetLessonIndex, searchLessons } from "../src/functions/lessons.js";
import type { Lesson } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (id: string, payload: unknown) => functions.get(id)!(payload),
  };
}

function lesson(id: string, content: string, project: string): Lesson {
  const now = new Date().toISOString();
  return {
    id, content, context: "", confidence: 0.8, reinforcements: 0, source: "manual",
    sourceIds: [], project, tags: [], createdAt: now, updatedAt: now, decayRate: 0.05,
  };
}

const TARGET = "lsn_target";
const QUERY = "deploy pipeline";

describe("Lesson recall filters by project before the candidate cut (#438)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    resetLessonIndex();
    registerLessonsFunctions(sdk as never, kv as never);
    for (let i = 0; i < 250; i++) {
      await kv.set("mem:lessons", `lsn_other_${i}`, lesson(`lsn_other_${i}`, `deploy pipeline deploy pipeline marker${i}`, "/other"));
    }
    await kv.set(
      "mem:lessons",
      TARGET,
      lesson(TARGET, "When the deploy pipeline stalls on the staging host, check the runner's disk quota, the lockfile age and the pending migration queue before restarting anything", "/app"),
    );
  });

  it("searchLessons returns this project's matching Lesson", async () => {
    const found = await searchLessons(kv as never, QUERY, "/app", 20);
    expect(found.map((l) => l.id)).toContain(TARGET);
  });

  it("mem::lesson-recall returns this project's matching Lesson", async () => {
    const result = (await sdk.trigger("mem::lesson-recall", { query: QUERY, project: "/app" })) as {
      lessons: Lesson[];
    };
    expect(result.lessons.map((l) => l.id)).toContain(TARGET);
  });

  it("mem::lesson-recall with a confidence floor still reaches past other projects' hits", async () => {
    const result = (await sdk.trigger("mem::lesson-recall", { query: QUERY, project: "/app", minConfidence: 0.5 })) as {
      lessons: Lesson[];
    };
    expect(result.lessons.map((l) => l.id)).toContain(TARGET);
  });
  it("keeps global Lessons visible to scoped and unscoped searches", async () => {
    const global = { ...lesson("lsn_global", "deploy pipeline global guidance", "/app"), project: undefined };
    await kv.set("mem:lessons", global.id, global);
    for (const project of ["/app", undefined]) {
      const found = await searchLessons(kv as never, "deploy pipeline global guidance", project, 10);
      expect(found.map((l) => l.id)).toContain(global.id);
      const result = (await sdk.trigger("mem::lesson-recall", { query: "deploy pipeline global guidance", project })) as { lessons: Lesson[] };
      expect(result.lessons.map((l) => l.id)).toContain(global.id);
    }
  });

  it("skips tombstones and low-confidence hits before the candidate cut", async () => {
    for (let i = 0; i < 150; i++) {
      const id = `lsn_ineligible_${i}`;
      await kv.set("mem:lessons", id, {
        ...lesson(id, `deploy pipeline deploy pipeline ineligible${i}`, "/app"),
        ...(i < 75 ? { deleted: true } : { confidence: 0.1 }),
      });
    }
    const result = (await sdk.trigger("mem::lesson-recall", { query: QUERY, project: "/app", minConfidence: 0.5 })) as { lessons: Lesson[] };
    expect(result.lessons.map((l) => l.id)).toContain(TARGET);
    expect(result.lessons.every((l) => !l.deleted && l.confidence >= 0.5)).toBe(true);
  });

});
