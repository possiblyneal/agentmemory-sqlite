import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));
const graphOn = vi.hoisted(() => ({ value: false }));
vi.mock("../src/functions/graph.js", () => ({
  graphWritesDisabled: () => !graphOn.value,
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { KV } from "../src/state/schema.js";
import type { Memory, AuditEntry } from "../src/types.js";

function mockKV() {
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
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from((store.get(scope) ?? new Map()).values()) as T[],
  };
}

function setup() {
  const functions = new Map<string, Function>();
  const triggers: Array<{ function_id: string; payload: any }> = [];
  const sdk = {
    registerFunction: (id: string, h: Function) => void functions.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload: unknown }) => {
      triggers.push(input as never);
      const fn = functions.get(input.function_id);
      if (!fn) return undefined;
      return fn(input.payload);
    },
  };
  const kv = mockKV();
  registerRememberFunction(sdk as never, kv as never);
  const remember = (data: Record<string, unknown>) =>
    functions.get("mem::remember")!(data) as Promise<any>;
  return { kv, remember, triggers };
}

describe("mem::remember fixes", () => {
  beforeEach(() => {
    graphOn.value = false;
  });

  it("persists sessionId into sessionIds and writes an audit row", async () => {
    const { kv, remember } = setup();
    const r = await remember({ content: "use pnpm for installs", sessionId: "ses_1" });
    expect(r.memory.sessionIds).toEqual(["ses_1"]);
    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(audits).toHaveLength(1);
    expect(audits[0].operation).toBe("remember");
    expect(audits[0].targetIds).toEqual([r.memory.id]);
  });

  it("defaults sessionIds to empty and records the superseded id in the audit", async () => {
    const { kv, remember } = setup();
    const a = await remember({ content: "deploy runs from the main branch every night" });
    expect(a.memory.sessionIds).toEqual([]);
    const b = await remember({ content: "deploy runs from the main branch every night!" });
    expect(b.memory.supersedes).toEqual([a.memory.id]);
    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(audits).toHaveLength(2);
    expect(audits[1].details).toMatchObject({ supersededMemoryId: a.memory.id });
  });

  it("rejects a non-string sessionId", async () => {
    const { remember } = setup();
    const r = await remember({ content: "x content here", sessionId: 5 });
    expect(r.success).toBe(false);
  });

  it("does not supersede across a negation polarity flip", async () => {
    const { kv, remember } = setup();
    const a = await remember({ content: "always use the shared cache layer for lookups here" });
    const b = await remember({ content: "never use the shared cache layer for lookups here" });
    expect(b.memory.supersedes).toEqual([]);
    const old = await kv.get<Memory>(KV.memories, a.memory.id);
    expect(old!.isLatest).toBe(true);
  });

  it("still supersedes when both sides are negated", async () => {
    const { remember } = setup();
    const a = await remember({ content: "never use the shared cache layer for lookups here" });
    const b = await remember({ content: "never use the shared cache layer for lookups here ever" });
    expect(b.memory.supersedes).toEqual([a.memory.id]);
  });

  it("does not supersede across a CJK polarity flip", async () => {
    const { remember } = setup();
    await remember({ content: "请使用缓存层处理所有查询请求" });
    const b = await remember({ content: "请不要使用缓存层处理所有查询请求" });
    expect(b.memory.supersedes).toEqual([]);
  });

  it("triggers graph-extract after a save only when graph writes are enabled", async () => {
    const off = setup();
    await off.remember({ content: "alpha beta gamma" });
    expect(off.triggers.filter((t) => t.function_id === "mem::graph-extract")).toHaveLength(0);

    graphOn.value = true;
    const on = setup();
    const r = await on.remember({ content: "alpha beta gamma" });
    const t = on.triggers.filter((x) => x.function_id === "mem::graph-extract");
    expect(t).toHaveLength(1);
    expect(t[0].payload.observations[0].id).toBe(r.memory.id);
  });

  it("never returns a graph-extract failure", async () => {
    graphOn.value = true;
    const functions = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, h: Function) => void functions.set(id, h),
      registerTrigger: () => {},
      trigger: (input: { function_id: string }) =>
        input.function_id === "mem::graph-extract"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(undefined),
    };
    registerRememberFunction(sdk as never, mockKV() as never);
    const r = await functions.get("mem::remember")!({ content: "alpha beta gamma" });
    expect(r.success).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
  });

  describe("leaked tool-call arguments", () => {
    const leaked = [
      'use the cache", "type": "pattern", "concepts": ["cache"]',
      'use the cache</parameter>\n<parameter name="type">pattern</parameter>',
    ];
    for (const content of leaked) {
      it(`rejects ${JSON.stringify(content.slice(-30))}`, async () => {
        const { kv, remember } = setup();
        const r = await remember({ content });
        expect(r.success).toBe(false);
        expect(r.error).toContain("tool-call");
        expect(await kv.list(KV.memories)).toHaveLength(0);
      });
    }

    it("saves quoted JSON whose keys share a name with remember's", async () => {
      const { remember } = setup();
      const r = await remember({ content: 'package.json declares "name": "x", "type": "module", "files": ["dist"]' });
      expect(r.success).toBe(true);
    });

    it("saves content that merely mentions one tag", async () => {
      const { remember } = setup();
      const r = await remember({ content: "the parser chokes on a stray </parameter> tag" });
      expect(r.success).toBe(true);
    });
  });
});
