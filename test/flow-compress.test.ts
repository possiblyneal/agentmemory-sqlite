import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerFlowCompressFunction } from "../src/functions/flow-compress.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { KV } from "../src/state/schema.js";
import type { Action, Lesson, Memory, MemoryProvider } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => fns.set(id, handler),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
  } as any;
}

function stubProvider(response: string): MemoryProvider {
  return {
    name: "stub",
    compress: async () => response,
    summarize: async () => response,
  } as unknown as MemoryProvider;
}

const LESSON = "Run the migration before seeding the database.";

const WITH_LESSON = `<summary>
<goal>Seed the staging database</goal>
<outcome>Seeded after a retry</outcome>
<steps>1. migrate 2. seed</steps>
<discoveries>Seeding fails on an unmigrated schema</discoveries>
<lesson>${LESSON}</lesson>
</summary>`;

const WITHOUT_LESSON = `<summary>
<goal>Seed the staging database</goal>
<outcome>Seeded</outcome>
<steps>1. seed</steps>
<discoveries>None</discoveries>
</summary>`;

function action(id: string, project: string): Action {
  return {
    id,
    title: `Seed staging ${id}`,
    description: "Seed the staging database",
    status: "done",
    priority: 5,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "agent",
    project,
    tags: [],
    sourceObservationIds: [],
    sourceMemoryIds: [],
  } as Action;
}

async function setup(
  response: string,
  opts: { projects?: string[]; project?: string | null } = {},
) {
  const kv = mockKV();
  const sdk = mockSdk();
  registerLessonsFunctions(sdk, kv as never);
  registerFlowCompressFunction(sdk, kv as never, stubProvider(response));
  const actions = (opts.projects ?? ["shop"]).map((p, i) => action(`act_${i + 1}`, p));
  for (const a of actions) await kv.set(KV.actions, a.id, a);
  const project = opts.project === undefined ? "shop" : opts.project ?? undefined;
  const compress = () =>
    sdk.trigger({
      function_id: "mem::flow-compress",
      payload: { actionIds: actions.map((a) => a.id), project },
    });
  return { kv, sdk, compress };
}

describe("mem::flow-compress Lessons (rohitg00/agentmemory#274)", () => {
  it("saves the extracted <lesson> as a flow Lesson tied to the project and Memory", async () => {
    const { kv, compress } = await setup(WITH_LESSON);

    const result = await compress();

    expect(result.success).toBe(true);
    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      content: LESSON,
      source: "flow",
      project: "shop",
      sourceIds: [result.memoryId],
    });
    const memory = await kv.get<Memory>(KV.memories, result.memoryId);
    expect(memory!.content).toContain(`Lesson: ${LESSON}`);
  });

  it("reinforces the Lesson on an identical second run instead of duplicating it", async () => {
    const { kv, compress } = await setup(WITH_LESSON);

    await compress();
    await compress();

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].reinforcements).toBe(1);
  });

  it("creates no Lesson when the response has no <lesson>", async () => {
    const { kv, compress } = await setup(WITHOUT_LESSON);

    const result = await compress();

    expect(result.success).toBe(true);
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(0);
  });

  it("takes the Lesson's project from the actions when no project is given and they share one", async () => {
    const { kv, compress } = await setup(WITH_LESSON, {
      projects: ["shop", "shop"],
      project: null,
    });

    const result = await compress();

    expect(result.success).toBe(true);
    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].project).toBe("shop");
  });

  it("saves no Lesson when no project is given and the actions span projects", async () => {
    const { kv, compress } = await setup(WITH_LESSON, {
      projects: ["shop", "billing"],
      project: null,
    });

    const result = await compress();

    expect(result.success).toBe(true);
    expect(await kv.get<Memory>(KV.memories, result.memoryId)).not.toBeNull();
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(0);
  });

  it("still succeeds with the Memory stored when the Lesson save throws", async () => {
    const { kv, sdk, compress } = await setup(WITH_LESSON);
    sdk.registerFunction("mem::lesson-save", async () => {
      throw new Error("lesson store down");
    });

    const result = await compress();

    expect(result.success).toBe(true);
    expect(await kv.get<Memory>(KV.memories, result.memoryId)).not.toBeNull();
  });

  it("still succeeds when the Lesson save reports failure", async () => {
    const { kv, sdk, compress } = await setup(WITH_LESSON);
    sdk.registerFunction("mem::lesson-save", async () => ({
      success: false,
      error: "content is required",
    }));

    const result = await compress();

    expect(result.success).toBe(true);
    expect(await kv.get<Memory>(KV.memories, result.memoryId)).not.toBeNull();
  });
});
