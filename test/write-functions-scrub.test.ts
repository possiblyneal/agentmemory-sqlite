import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerActionsFunction } from "../src/functions/actions.js";
import { registerCheckpointsFunction } from "../src/functions/checkpoints.js";
import { registerSignalsFunction } from "../src/functions/signals.js";
import { registerSentinelsFunction } from "../src/functions/sentinels.js";
import { registerFacetsFunction } from "../src/functions/facets.js";
import { registerWorkingMemoryFunctions } from "../src/functions/working-memory.js";
import { registerSketchesFunction } from "../src/functions/sketches.js";
import { registerRoutinesFunction } from "../src/functions/routines.js";

const SECRET = "ghp_" + "A".repeat(36);
const REDACTED = "[REDACTED_SECRET]";

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
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      [...(store.get(scope)?.values() ?? [])] as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
  };
}

function everythingStored(kv: ReturnType<typeof mockKV>): string {
  const rows: unknown[] = [];
  for (const scope of kv.store.values()) rows.push(...scope.values());
  return JSON.stringify(rows);
}

type Case = {
  name: string;
  register: (sdk: any, kv: any) => void;
  run: (call: (id: string, payload: unknown) => Promise<any>) => Promise<void>;
};

const cases: Case[] = [
  {
    name: "mem::remember content",
    register: registerRememberFunction,
    run: async (call) => {
      await call("mem::remember", { content: `token is ${SECRET} for prod` });
    },
  },
  {
    name: "mem::lesson-save content and context",
    register: registerLessonsFunctions,
    run: async (call) => {
      await call("mem::lesson-save", {
        content: `never paste ${SECRET}`,
        context: `seen in ${SECRET}`,
      });
    },
  },
  {
    name: "mem::action-create title and description",
    register: registerActionsFunction,
    run: async (call) => {
      await call("mem::action-create", {
        title: `rotate ${SECRET}`,
        description: `it was ${SECRET}`,
      });
    },
  },
  {
    name: "mem::action-update title, description and result",
    register: registerActionsFunction,
    run: async (call) => {
      const created = await call("mem::action-create", { title: "clean" });
      await call("mem::action-update", {
        actionId: created.action.id,
        title: `t ${SECRET}`,
        description: `d ${SECRET}`,
        result: `r ${SECRET}`,
      });
    },
  },
  {
    name: "mem::checkpoint-create name and description",
    register: registerCheckpointsFunction,
    run: async (call) => {
      await call("mem::checkpoint-create", {
        name: `cp ${SECRET}`,
        description: `d ${SECRET}`,
      });
    },
  },
  {
    name: "mem::signal-send content",
    register: registerSignalsFunction,
    run: async (call) => {
      await call("mem::signal-send", { from: "a", content: `use ${SECRET}` });
    },
  },
  {
    name: "mem::sentinel-create name",
    register: registerSentinelsFunction,
    run: async (call) => {
      await call("mem::sentinel-create", { name: `s ${SECRET}`, type: "custom" });
    },
  },
  {
    name: "mem::facet-tag value",
    register: registerFacetsFunction,
    run: async (call) => {
      await call("mem::facet-tag", {
        targetId: "mem_1",
        targetType: "memory",
        dimension: "note",
        value: `v ${SECRET}`,
      });
    },
  },
  {
    name: "mem::core-add content",
    register: registerWorkingMemoryFunctions,
    run: async (call) => {
      await call("mem::core-add", { content: `core ${SECRET}` });
    },
  },
  {
    name: "mem::sketch-create and mem::sketch-add title and description",
    register: registerSketchesFunction,
    run: async (call) => {
      const created = await call("mem::sketch-create", {
        title: `sk ${SECRET}`,
        description: `d ${SECRET}`,
      });
      await call("mem::sketch-add", {
        sketchId: created.sketch.id,
        title: `step ${SECRET}`,
        description: `d2 ${SECRET}`,
      });
    },
  },
  {
    name: "mem::routine-create name and description",
    register: registerRoutinesFunction,
    run: async (call) => {
      await call("mem::routine-create", {
        name: `r ${SECRET}`,
        description: `d ${SECRET}`,
        steps: [{ order: 1, title: "one", description: "x", actionTemplate: {}, dependsOn: [] }],
      });
    },
  },
];

describe("write functions scrub secrets before storing", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const sdk = mockSdk();
      const kv = mockKV();
      c.register(sdk, kv);
      const call = async (id: string, payload: unknown) => {
        const handler = sdk.fns.get(id);
        if (!handler) throw new Error(`no handler ${id}`);
        return handler(payload);
      };
      await c.run(call);
      const stored = everythingStored(kv);
      expect(stored).not.toContain(SECRET);
      expect(stored).toContain(REDACTED);
    });
  }
});
