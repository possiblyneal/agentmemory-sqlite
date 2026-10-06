import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { KV } from "../src/state/schema.js";
import type { Insight, Lesson } from "../src/types.js";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const T0 = Date.parse("2026-01-05T12:00:00.000Z");
const at = (weeks: number, days = 0) => T0 + weeks * WEEK + days * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const set = async <T>(scope: string, key: string, data: T): Promise<T> => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)!.set(key, data);
    return data;
  };
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set,
    setMany: async <T>(scope: string, entries: Array<{ key: string; value: T }>): Promise<number> => {
      for (const e of entries) await set(scope, e.key, e.value);
      return entries.length;
    },
    setManyIfUnchanged: async <T>(
      scope: string,
      entries: Array<{ key: string; value: T; updatedAt: string }>,
    ): Promise<string[]> => {
      const written: string[] = [];
      for (const { key, value, updatedAt } of entries) {
        const row = store.get(scope)?.get(key) as { updatedAt?: string } | undefined;
        if (row?.updatedAt !== updatedAt) continue;
        store.get(scope)!.set(key, value);
        written.push(key);
      }
      return written;
    },
    deleteManyIfUnchanged: async (
      scope: string,
      entries: Array<{ key: string; updatedAt: string }>,
    ): Promise<string[]> => {
      const deleted: string[] = [];
      for (const { key, updatedAt } of entries) {
        const row = store.get(scope)?.get(key) as { updatedAt?: string } | undefined;
        if (row?.updatedAt !== updatedAt) continue;
        store.get(scope)!.delete(key);
        deleted.push(key);
      }
      return deleted;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      structuredClone(Array.from(store.get(scope)?.values() ?? [])) as T[],
  };
}

const weeks = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
    functions,
  };
}

describe("Lesson decay on Project Time", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, undefined);
    registerLessonsFunctions(sdk as never, kv as never);
    sdk.functions.set("mem::context", () => ({ context: "" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startSessions(project: string, weeks: number[]) {
    for (const w of weeks) {
      vi.setSystemTime(at(w));
      await sdk.trigger({
        function_id: "api::session::start",
        payload: { headers: {}, body: { sessionId: `ses_${project}_${w}`, project, cwd: project } },
      });
    }
  }

  async function saveLesson(content: string, project?: string): Promise<string> {
    vi.setSystemTime(at(0, 1));
    const result = (await sdk.trigger({
      function_id: "mem::lesson-save",
      payload: { content, project },
    })) as { lesson: Lesson };
    return result.lesson.id;
  }

  async function sweepAt(weeks: number) {
    vi.setSystemTime(at(weeks, 2));
    return sdk.trigger({ function_id: "mem::lesson-decay-sweep", payload: {} });
  }

  const lesson = (id: string) => kv.get<Lesson>(KV.lessons, id);

  it("keeps a dormant project's Lesson at the confidence it was left with", async () => {
    await startSessions("/repo", [0]);
    const id = await saveLesson("dormant rule", "/repo");

    await sweepAt(12);

    const after = await lesson(id);
    expect(after!.confidence).toBe(0.5);
    expect(after!.deleted).toBeFalsy();
    expect(after!.lastDecayedAt).toBeUndefined();
  });

  it("soft-deletes an unreinforced Lesson after twelve active weeks", async () => {
    const id = await saveLesson("active rule", "/repo");
    await startSessions("/repo", weeks(1, 12));

    await sweepAt(12);

    expect((await lesson(id))!.deleted).toBe(true);
    const audit = await kv.list<{ functionId: string; details: Record<string, unknown> }>(KV.audit);
    const entry = audit.find((a) => a.functionId === "mem::lesson-decay-sweep");
    expect(entry!.details).toMatchObject({ action: "soft-delete", activeWeeks: 12 });
  });

  it("does not decay one project's Lessons for work in another", async () => {
    const id = await saveLesson("isolated rule", "/repo");
    await startSessions("/other", weeks(1, 12));

    await sweepAt(12);

    expect((await lesson(id))!.confidence).toBe(0.5);
  });

  it("decays a Lesson with no project in weeks when any project was active", async () => {
    const id = await saveLesson("global rule");
    await startSessions("/other", weeks(1, 12));

    await sweepAt(12);

    expect((await lesson(id))!.deleted).toBe(true);
  });

  it("carries no pending debt out of dormant weeks", async () => {
    const id = await saveLesson("resumed rule", "/repo");
    await startSessions("/repo", [12]);

    await sweepAt(12);

    expect((await lesson(id))!.confidence).toBeCloseTo(0.45, 3);
  });

  it("gives the same result after the Sessions are evicted", async () => {
    const id = await saveLesson("evicted rule", "/repo");
    await startSessions("/repo", weeks(1, 12));
    for (const s of await kv.list<{ id: string }>(KV.sessions)) {
      await kv.delete(KV.sessions, s.id);
    }

    await sweepAt(12);

    expect((await lesson(id))!.deleted).toBe(true);
  });

  it("backfills activity from Sessions and Session Summaries without a jump", async () => {
    const base = {
      context: "", reinforcements: 1, source: "manual" as const, sourceIds: [], tags: [],
      createdAt: iso(at(0)), updatedAt: iso(at(0)), decayRate: 0.05, project: "/repo",
    };
    await kv.set(KV.lessons, "lsn_recent", {
      ...base, id: "lsn_recent", content: "recently decayed", confidence: 0.4,
      lastDecayedAt: iso(at(12, 1)),
    });
    await kv.set(KV.lessons, "lsn_behind", {
      ...base, id: "lsn_behind", content: "decayed weeks ago", confidence: 0.4,
      lastDecayedAt: iso(at(9)),
    });
    await kv.set(KV.sessions, "ses_old", { id: "ses_old", project: "/repo", startedAt: iso(at(10)) });
    await kv.set(KV.summaries, "ses_gone", { sessionId: "ses_gone", project: "/repo", createdAt: iso(at(11)) });

    await sweepAt(12);

    expect((await lesson("lsn_recent"))!.confidence).toBe(0.4);
    expect((await lesson("lsn_behind"))!.confidence).toBeCloseTo(0.3, 3);
  });
});

describe("Insight decay on Project Time", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, undefined);
    registerReflectFunctions(sdk as never, kv as never, {} as never);
    sdk.functions.set("mem::context", () => ({ context: "" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startSessions(project: string, weeksIn: number[]) {
    for (const w of weeksIn) {
      vi.setSystemTime(at(w));
      await sdk.trigger({
        function_id: "api::session::start",
        payload: { headers: {}, body: { sessionId: `ses_${project}_${w}`, project, cwd: project } },
      });
    }
  }

  async function saveInsight(id: string, project?: string) {
    const created = iso(at(0, 1));
    await kv.set<Insight>(KV.insights, id, {
      id, title: id, content: id, confidence: 0.5, reinforcements: 0,
      sourceConceptCluster: [], sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
      tags: [], createdAt: created, updatedAt: created, decayRate: 0.05, project,
    });
  }

  async function sweepAt(weeksIn: number) {
    vi.setSystemTime(at(weeksIn, 2));
    return sdk.trigger({ function_id: "mem::insight-decay-sweep", payload: {} });
  }

  const insight = (id: string) => kv.get<Insight>(KV.insights, id);

  it("keeps a dormant project's Insight at the confidence it was left with", async () => {
    await startSessions("/repo", [0]);
    await saveInsight("ins_dormant", "/repo");

    await sweepAt(12);

    expect((await insight("ins_dormant"))!.confidence).toBe(0.5);
  });

  it("deletes an unreinforced Insight after twelve active weeks", async () => {
    await saveInsight("ins_active", "/repo");
    await startSessions("/repo", weeks(1, 12));

    await sweepAt(12);

    expect(await insight("ins_active")).toBeNull();
  });

  it("does not decay one project's Insights for work in another", async () => {
    await saveInsight("ins_isolated", "/repo");
    await startSessions("/other", weeks(1, 12));

    await sweepAt(12);

    expect((await insight("ins_isolated"))!.confidence).toBe(0.5);
  });

  it("decays an Insight with no project in weeks when any project was active", async () => {
    await saveInsight("ins_global");
    await startSessions("/other", weeks(1, 12));

    await sweepAt(12);

    expect(await insight("ins_global")).toBeNull();
  });

  it("records the active weeks it applied in the audit", async () => {
    await saveInsight("ins_resumed", "/repo");
    await startSessions("/repo", [12]);

    await sweepAt(12);

    expect((await insight("ins_resumed"))!.confidence).toBeCloseTo(0.45, 3);
    const audit = await kv.list<{ functionId: string; details: Record<string, unknown> }>(KV.audit);
    const entry = audit.find((a) => a.functionId === "mem::insight-decay-sweep");
    expect(entry!.details).toMatchObject({ activeWeeks: { ins_resumed: 1 } });
  });
});
