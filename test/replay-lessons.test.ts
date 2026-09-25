import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { extractLessons, registerReplayFunctions } from "../src/functions/replay.js";
import { KV } from "../src/state/schema.js";
import type { Lesson } from "../src/types.js";

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
      fns.get(input.function_id)?.(input.payload) ?? { success: true },
  } as any;
}

describe("extractLessons (#1292)", () => {
  it("keeps a whole sentence that opens with a trigger", () => {
    expect(
      extractLessons(["Done. Always run the migration before seeding the db."]),
    ).toEqual(["Always run the migration before seeding the db."]);
  });

  it("drops a trigger that sits mid-sentence and would lose its subject", () => {
    expect(
      extractLessons(["The watchdog must never restart on ROUTE_MISSING_404."]),
    ).toEqual([]);
  });

  it("does not stop at a dot inside a filename", () => {
    expect(
      extractLessons(["Never edit config.ts by hand, regenerate it instead."]),
    ).toEqual(["Never edit config.ts by hand, regenerate it instead."]);
  });

  it("accepts a trigger after a list marker", () => {
    expect(extractLessons(["- Prefer node:sqlite over a native addon here."])).toEqual([
      "Prefer node:sqlite over a native addon here.",
    ]);
  });

  it("ignores triggers inside identifiers and unbalanced markup", () => {
    expect(
      extractLessons([
        "dont-repeat-yourself]]/some-page is linked here",
        "Never mix** the statistical constraint with the other one",
      ]),
    ).toEqual([]);
  });

  it("rejects a sentence longer than the cap instead of truncating it", () => {
    expect(extractLessons([`Always ${"x ".repeat(120)}end.`])).toEqual([]);
  });

  it("returns each lesson once", () => {
    expect(
      extractLessons(["Avoid global state in hooks.", "avoid global state in hooks."]),
    ).toEqual(["Avoid global state in hooks."]);
  });
});

describe("import-jsonl lesson re-derivation (#1292)", () => {
  it("does not reinforce a lesson just because a re-import matched it again", async () => {
    const root = mkdtempSync(join(tmpdir(), "replay-lessons-"));
    const dir = join(root, "proj");
    mkdirSync(dir);
    const ts = "2026-04-17T10:00:00.000Z";
    writeFileSync(
      join(dir, "sess-lesson.jsonl"),
      [
        { type: "user", sessionId: "sess-lesson", timestamp: ts, cwd: root,
          message: { role: "user", content: [{ type: "text", text: "hello" }] } },
        { type: "assistant", sessionId: "sess-lesson", timestamp: ts,
          message: { role: "assistant", content: [{ type: "text", text: "Always run the migration before seeding." }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const kv = mockKV();
    const sdk = mockSdk();
    registerReplayFunctions(sdk, kv as never);

    await sdk.trigger({ function_id: "mem::replay::import-jsonl", payload: { path: root } });
    await sdk.trigger({ function_id: "mem::replay::import-jsonl", payload: { path: root } });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].reinforcements).toBe(0);
    expect(lessons[0].lastReinforcedAt).toBeUndefined();
  });
});
