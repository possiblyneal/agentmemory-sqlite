import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerReplayFunctions } from "../src/functions/replay.js";
import { KV, fingerprintId } from "../src/state/schema.js";

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
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ) => {
      const row = { ...(store.get(scope)?.get(key) as Record<string, unknown>) };
      for (const op of ops) if (op.type === "set") row[op.path] = op.value;
      store.get(scope)!.set(key, row);
      return { new_value: row };
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk(kv: ReturnType<typeof mockKV>) {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => fns.set(id, handler),
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : (idOrInput as any).payload;
      const fn = fns.get(id);
      if (!fn) return { success: true };
      return fn(payload);
    },
    _kv: kv,
  } as any;
}

const SID = "sess-reimport";

function editLine(uuid: string, ts: string, filePath: string, cwd: string) {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: SID,
    timestamp: ts,
    cwd,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `tu-${uuid}`, name: "Edit", input: { file_path: filePath } }],
    },
  });
}

function line(type: "user" | "assistant", uuid: string, ts: string, text: string, cwd: string) {
  return JSON.stringify({
    type,
    uuid,
    sessionId: SID,
    timestamp: ts,
    cwd,
    message: { role: type, content: [{ type: "text", text }] },
  });
}

describe("import-jsonl re-import skips stored Observations", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "replay-reimport-"));
    file = join(root, `${SID}.jsonl`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function setup() {
    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerReplayFunctions(sdk, kv as never);
    const run = () =>
      sdk.trigger("mem::replay::import-jsonl", { path: root }) as Promise<{ observations: number }>;
    const stored = async () => (await kv.list(KV.observations(SID))).length;
    const count = async () => (await kv.get<any>(KV.sessions, SID))?.observationCount;
    const crystal = () => kv.get<any>(KV.crystals, fingerprintId("crystal", SID));
    return { kv, run, stored, count, crystal };
  }

  it("stores each Observation once when the same transcript is imported twice", async () => {
    writeFileSync(
      file,
      [line("user", "u1", "2026-04-17T10:00:00Z", "hello", root), line("assistant", "a1", "2026-04-17T10:00:01Z", "world", root)].join("\n") + "\n",
    );
    const { run, stored, count } = await setup();
    expect((await run()).observations).toBe(2);
    expect((await run()).observations).toBe(0);
    expect(await stored()).toBe(2);
    expect(await count()).toBe(2);
  });

  it("adds only the new turns when the transcript has grown", async () => {
    writeFileSync(file, line("user", "u1", "2026-04-17T10:00:00Z", "hello", root) + "\n");
    const { run, stored, count } = await setup();
    await run();
    appendFileSync(file, line("assistant", "a1", "2026-04-17T10:00:01Z", "world", root) + "\n");
    expect((await run()).observations).toBe(1);
    expect(await stored()).toBe(2);
    expect(await count()).toBe(2);
  });

  it("stores two distinct turns with identical text", async () => {
    writeFileSync(
      file,
      [line("user", "u1", "2026-04-17T10:00:00Z", "again", root), line("user", "u2", "2026-04-17T10:05:00Z", "again", root)].join("\n") + "\n",
    );
    const { run, stored } = await setup();
    await run();
    expect(await stored()).toBe(2);
  });

  it("counts a line repeated within one file once", async () => {
    const turn = line("user", "u1", "2026-04-17T10:00:00Z", "hello", root);
    writeFileSync(file, [turn, turn].join("\n") + "\n");
    const { run, stored, count } = await setup();
    expect((await run()).observations).toBe(1);
    expect(await stored()).toBe(1);
    expect(await count()).toBe(1);
  });

  it("keeps the crystal's files when the transcript is imported again", async () => {
    writeFileSync(
      file,
      [line("user", "u1", "2026-04-17T10:00:00Z", "fix the parser", root), editLine("a1", "2026-04-17T10:00:01Z", join(root, "parser.ts"), root)].join("\n") + "\n",
    );
    const { run, crystal } = await setup();
    await run();
    const first = await crystal();
    await run();
    expect(first.filesAffected.length).toBeGreaterThan(0);
    expect((await crystal()).filesAffected).toEqual(first.filesAffected);
  });

  it("keeps each import of a transcript without a sessionId apart", async () => {
    writeFileSync(
      file,
      JSON.stringify({ type: "user", timestamp: "2026-04-17T10:00:00Z", cwd: root, message: { role: "user", content: "hello" } }) + "\n",
    );
    const { kv, run } = await setup();
    const ids = async () => {
      const [sid] = ((await run()) as unknown as { sessionIds: string[] }).sessionIds;
      return (await kv.list<{ id: string }>(KV.observations(sid))).map((o) => o.id);
    };
    const [first, second] = [await ids(), await ids()];
    expect(first).toHaveLength(1);
    expect(second).not.toEqual(first);
  });
});
