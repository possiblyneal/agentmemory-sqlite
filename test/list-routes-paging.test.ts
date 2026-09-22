import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

const SECRET = "paging-test-secret";

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
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

type Route = "api::sessions" | "api::semantic-list" | "api::procedural-list" | "api::memories";

let kv: ReturnType<typeof mockKV>;
let sdk: ReturnType<typeof mockSdk>;

async function get(route: Route, query: Record<string, string> = {}) {
  return sdk._fns.get(route)!({
    headers: { authorization: `Bearer ${SECRET}` },
    query_params: query,
  }) as Promise<{ status_code: number; body: Record<string, unknown> }>;
}

function makeSession(n: number): Session {
  return {
    id: `ses_${n}`,
    project: "proj",
    cwd: "/proj",
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    status: "completed",
    observationCount: 0,
  };
}

async function seedSessions(count: number) {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const n of order) await kv.set(KV.sessions, `ses_${n}`, makeSession(n));
}

async function seedRows(scope: string, count: number) {
  for (let n = 0; n < count; n++) {
    await kv.set(scope, `row_${n}`, { id: `row_${n}`, n });
  }
}

beforeEach(() => {
  kv = mockKV();
  sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
});

describe("GET /agentmemory/sessions paging", () => {
  it("returns the newest 100 by default with the full total", async () => {
    await seedSessions(130);
    const res = await get("api::sessions");
    const sessions = res.body.sessions as Session[];
    expect(sessions).toHaveLength(100);
    expect(res.body.total).toBe(130);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(sessions[0]!.id).toBe("ses_129");
    expect(sessions[99]!.id).toBe("ses_30");
  });

  it("orders newest-first before paging and honours limit/offset", async () => {
    await seedSessions(25);
    const res = await get("api::sessions", { limit: "10", offset: "10" });
    const ids = (res.body.sessions as Session[]).map((s) => s.id);
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `ses_${14 - i}`));
    expect(res.body.total).toBe(25);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(10);
  });

  it("returns every Session for limit=all", async () => {
    await seedSessions(130);
    const res = await get("api::sessions", { limit: "all" });
    expect(res.body.sessions).toHaveLength(130);
    expect(res.body.total).toBe(130);
    expect(res.body.limit).toBe("all");
  });

  it("sorts a Session row without startedAt last instead of throwing", async () => {
    await seedSessions(3);
    await kv.set(KV.sessions, "ses_ghost", { endedAt: "2026-09-01T00:00:00.000Z", status: "completed" });
    const res = await get("api::sessions");
    const ids = (res.body.sessions as Array<{ id?: string }>).map((s) => s.id);
    expect(ids).toEqual(["ses_2", "ses_1", "ses_0", undefined]);
    expect(res.body.total).toBe(4);
  });

  it("counts the total after the agent filter", async () => {
    await seedSessions(5);
    await kv.set(KV.sessions, "ses_other", { ...makeSession(99), id: "ses_other", agentId: "other" });
    const res = await get("api::sessions", { agentId: "other", limit: "2" });
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it("falls back to the defaults for a malformed limit or offset", async () => {
    await seedSessions(3);
    const res = await get("api::sessions", { limit: "-4", offset: "x" });
    expect(res.body.sessions).toHaveLength(3);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
  });

  it("still attaches the stored Session Summary to the page it returns", async () => {
    await seedSessions(3);
    await kv.set(KV.summaries, "ses_2", { sessionId: "ses_2", request: "r" });
    const res = await get("api::sessions", { limit: "1" });
    const [first] = res.body.sessions as Array<Session & { summary?: unknown }>;
    expect(first!.id).toBe("ses_2");
    expect(first!.summary).toEqual({ sessionId: "ses_2", request: "r" });
  });
});

describe.each([
  ["api::semantic-list" as const, KV.semantic, "semantic"],
  ["api::procedural-list" as const, KV.procedural, "procedural"],
  ["api::memories" as const, KV.memories, "memories"],
])("GET %s paging", (route, scope, key) => {
  it("returns at most 100 rows plus the full total", async () => {
    await seedRows(scope, 120);
    const res = await get(route);
    expect(res.body[key]).toHaveLength(100);
    expect(res.body.total).toBe(120);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
  });

  it("pages with limit/offset", async () => {
    await seedRows(scope, 12);
    const res = await get(route, { limit: "5", offset: "10" });
    expect(res.body[key]).toHaveLength(2);
    expect(res.body.total).toBe(12);
    expect(res.body.offset).toBe(10);
  });

  it("returns everything for limit=all", async () => {
    await seedRows(scope, 120);
    const res = await get(route, { limit: "all" });
    expect(res.body[key]).toHaveLength(120);
    expect(res.body.limit).toBe("all");
  });
});

describe("GET /agentmemory/memories paging", () => {
  it("pages the latest-filtered set and counts total after the filter", async () => {
    for (let n = 0; n < 6; n++) {
      await kv.set(KV.memories, `mem_${n}`, { id: `mem_${n}`, isLatest: n % 2 === 0 });
    }
    const res = await get("api::memories", { latest: "true", limit: "2", offset: "1" });
    expect((res.body.memories as Array<{ id: string }>).map((m) => m.id)).toEqual(["mem_2", "mem_4"]);
    expect(res.body.total).toBe(3);
  });

  it("still answers count=true with totals only", async () => {
    await seedRows(KV.memories, 3);
    const res = await get("api::memories", { count: "true" });
    expect(res.body).toEqual({ total: 3, latestCount: 0 });
  });
});
