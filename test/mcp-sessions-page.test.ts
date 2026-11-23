import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";

const SECRET = "sessions-page-secret";

function mockKV(sessions: Array<Record<string, unknown>>) {
  const store = new Map<string, Map<string, unknown>>([
    ["mem:sessions", new Map(sessions.map((s) => [s.id as string, s]))],
  ]);
  return {
    get: async (scope: string, key: string) => store.get(scope)?.get(key) ?? null,
    set: async () => {},
    delete: async () => {},
    list: async (scope: string) => [...(store.get(scope)?.values() ?? [])],
  };
}

async function callSessions(
  sessions: Array<Record<string, unknown>>,
  args: Record<string, unknown> = {},
  name = "memory_sessions",
) {
  const fns = new Map<string, Function>();
  const sdk = {
    registerFunction: (id: string, h: Function) => void fns.set(id, h),
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
  registerMcpEndpoints(sdk as never, mockKV(sessions) as never, SECRET);
  const res = await fns.get("mcp::tools::call")!({
    headers: { authorization: `Bearer ${SECRET}` },
    body: { name, arguments: args },
  });
  return res;
}

async function listSessions(
  sessions: Array<Record<string, unknown>>,
  args: Record<string, unknown> = {},
) {
  const res = await callSessions(sessions, args);
  return JSON.parse(res.body.content[0].text);
}

const rows = [
  { id: "old", startedAt: "2026-01-01T00:00:00.000Z" },
  { id: "none" },
  { id: "new", startedAt: "2026-03-01T00:00:00.000Z" },
  { id: "mid", startedAt: "2026-02-01T00:00:00.000Z" },
];

describe("memory_sessions", () => {
  it("returns Sessions newest first, rows without startedAt last, with total", async () => {
    const out = await listSessions(rows);
    expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["new", "mid", "old", "none"]);
    expect(out.total).toBe(4);
  });

  it("honours limit while total counts every Session", async () => {
    const out = await listSessions(rows, { limit: 2 });
    expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["new", "mid"]);
    expect(out.total).toBe(4);
  });

  it("applies date bounds before Session pagination", async () => {
    const out = await listSessions(rows, { after: "2026-01-01T00:00:00Z", before: "2026-03-01T00:00:00Z", limit: 1, offset: 1 });
    expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["old"]);
    expect(out.total).toBe(2);
  });

  it.each([["memory_recall", "mem::search"], ["memory_smart_search", "mem::smart-search"]])("forwards bounds through daemon MCP %s", async (name, target) => {
    const fns = new Map<string, Function>();
    let forwarded: { function_id: string; payload: unknown } | undefined;
    const sdk = { registerFunction: (id: string, handler: Function) => void fns.set(id, handler), registerTrigger: () => {}, trigger: async (input: { function_id: string; payload: unknown }) => { forwarded = input; return {}; } };
    registerMcpEndpoints(sdk as never, mockKV(rows) as never, SECRET);
    const bounds = { after: "2025-12-31T19:00:00-05:00", before: "2026-03-01T01:00:00+01:00" };
    const res = await fns.get("mcp::tools::call")!({ headers: { authorization: `Bearer ${SECRET}` }, body: { name, arguments: { query: "auth", ...bounds } } });
    expect(res.status_code).toBe(200);
    expect(forwarded?.function_id).toBe(target);
    expect(forwarded?.payload).toMatchObject(bounds);
  });

  it.each(["memory_sessions", "memory_recall", "memory_smart_search"])("rejects malformed and reversed date bounds for %s", async (name) => {
    for (const bounds of [{ after: "2026-01-01" }, { before: "2026-02-30T00:00:00Z" }, { after: "2026-02-01T00:00:00Z", before: "2026-01-01T00:00:00Z" }]) {
      const res = await callSessions(rows, { query: "auth", ...bounds }, name);
      expect(res.status_code).toBe(400);
    }
  });

  it("skips offset Sessions from the newest", async () => {
    const out = await listSessions(rows, { limit: 2, offset: 1 });
    expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["mid", "old"]);
    expect(out.total).toBe(4);
  });

  it.each([{ limit: 0 }, { limit: 2.5 }, { limit: "5" }, { offset: -1 }, { offset: 1.5 }])(
    "rejects %o instead of falling back to a default",
    async (args) => {
      const res = await callSessions(rows, args);
      expect(res.status_code).toBe(400);
    },
  );

  it("shows only this agent's Sessions when agent scope is isolated, as REST does", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    try {
      const out = await listSessions([
        { id: "mine", agentId: "agent-a", startedAt: "2026-01-01T00:00:00.000Z" },
        { id: "theirs", agentId: "agent-b", startedAt: "2026-01-02T00:00:00.000Z" },
      ]);
      expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["mine"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
