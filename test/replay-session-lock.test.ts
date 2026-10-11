import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerReplayFunctions } from "../src/functions/replay.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function mockKV() {
  const store = new Map<string, Map<string, any>>();
  let onSessionGet: (() => void) | null = null;
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const value = store.get(scope)?.get(key);
      const snapshot = value === undefined ? null : structuredClone(value);
      if (scope === KV.sessions && onSessionGet) {
        const fire = onSessionGet;
        onSessionGet = null;
        fire();
      }
      await tick();
      return snapshot as T | null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      await tick();
      await tick();
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
      return value;
    },
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value: unknown }>,
    ) => {
      await tick();
      const row = store.get(scope)?.get(key);
      for (const op of ops) row[op.path] = op.value;
    },
    delete: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    armSessionGet: (fn: () => void) => {
      onSessionGet = fn;
    },
  };
}

function mockSdk() {
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
      return fn ? fn(payload) : { success: true };
    },
  } as any;
}

describe("import-jsonl holds the Session lock for its Session write", () => {
  let tmpRoot: string;
  const sessionId = "sess-locked";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "replay-session-lock-"));
    const dir = join(tmpRoot, "proj");
    mkdirSync(dir, { recursive: true });
    const ts = "2026-04-17T10:00:00.000Z";
    const lines = [
      { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
    ].map((l) => JSON.stringify({ ...l, sessionId, timestamp: ts, cwd: tmpRoot }));
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const seed = (observationCount: number): Session => ({
    id: sessionId,
    project: "proj",
    cwd: tmpRoot,
    startedAt: "2026-04-17T09:00:00Z",
    status: "active",
    observationCount,
  });

  async function runImport(kv: ReturnType<typeof mockKV>) {
    const sdk = mockSdk();
    registerReplayFunctions(sdk, kv as never);
    return sdk.trigger("mem::replay::import-jsonl", { path: tmpRoot });
  }

  it("keeps the count of an observe racing an import on an existing Session", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, sessionId, seed(2));
    let observe: Promise<void> = Promise.resolve();
    kv.armSessionGet(() => {
      observe = withKeyedLock(`obs:${sessionId}`, async () => {
        const s = await kv.get<Session>(KV.sessions, sessionId);
        s!.observationCount += 1;
        await kv.set(KV.sessions, sessionId, s);
      });
    });

    await runImport(kv);
    await observe;

    const stored = await kv.get<Session>(KV.sessions, sessionId);
    expect(stored?.observationCount).toBe(2 + 2 + 1);
  });

  it("keeps the commit shas of a commit link racing an import", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, sessionId, seed(2));
    let link: Promise<void> = Promise.resolve();
    kv.armSessionGet(() => {
      link = withKeyedLock(`obs:${sessionId}`, async () => {
        const s = await kv.get<Session>(KV.sessions, sessionId);
        await kv.update(KV.sessions, sessionId, [
          { type: "set", path: "commitShas", value: [...(s?.commitShas ?? []), "abc123"] },
        ]);
      });
    });

    await runImport(kv);
    await link;

    const stored = await kv.get<Session>(KV.sessions, sessionId);
    expect(stored?.commitShas).toEqual(["abc123"]);
    expect(stored?.observationCount).toBe(4);
  });

  it("keeps a field an unlocked writer sets while an import updates the Session", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, sessionId, seed(2));
    let watermark: Promise<void> = Promise.resolve();
    kv.armSessionGet(() => {
      watermark = kv.update(KV.sessions, sessionId, [
        { type: "set", path: "graphExtractedThrough", value: "2026-04-17T09:30:00Z" },
      ]);
    });

    await runImport(kv);
    await watermark;

    const stored = await kv.get<Session>(KV.sessions, sessionId);
    expect(stored?.graphExtractedThrough).toBe("2026-04-17T09:30:00Z");
    expect(stored?.observationCount).toBe(4);
  });

  it("keeps the count of an observe that creates the Session an import is also creating", async () => {
    const kv = mockKV();
    let observe: Promise<void> = Promise.resolve();
    kv.armSessionGet(() => {
      observe = withKeyedLock(`obs:${sessionId}`, async () => {
        const s = await kv.get<Session>(KV.sessions, sessionId);
        if (s) {
          s.observationCount += 1;
          await kv.set(KV.sessions, sessionId, s);
        } else {
          await kv.set(KV.sessions, sessionId, seed(1));
        }
      });
    });

    await runImport(kv);
    await observe;

    const stored = await kv.get<Session>(KV.sessions, sessionId);
    expect(stored?.observationCount).toBe(2 + 1);
  });
});
