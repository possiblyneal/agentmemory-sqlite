import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerPatternsFunction } from "../src/functions/patterns.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";

const SECRET = "patterns-test-secret";

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
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

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

type Pattern = { type: string; files: string[]; sessions: string[] };

async function seedSession(
  kv: ReturnType<typeof mockKV>,
  id: string,
  startedAt: string,
  observations: Array<{ type: string; title: string; files?: string[] }>,
) {
  await kv.set(KV.sessions, id, {
    id,
    project: "proj",
    cwd: "/proj",
    startedAt,
    status: "completed",
    observationCount: observations.length,
  });
  await Promise.all(
    observations.map((obs, i) =>
      kv.set(KV.observations(id), `${id}-obs-${i}`, { id: `${id}-obs-${i}`, ...obs }),
    ),
  );
}

function setup() {
  const sdk = mockSdk();
  const kv = mockKV();
  registerPatternsFunction(sdk as never, kv as never);
  const patterns = (payload: Record<string, unknown>) =>
    sdk.trigger({ function_id: "mem::patterns", payload }) as Promise<{
      patterns: Pattern[];
    }>;
  return { kv, patterns };
}

describe("mem::patterns session window (rohitg00/agentmemory#1226)", () => {
  it("reads only the most recent `limit` Sessions by start time", async () => {
    const { kv, patterns } = setup();
    const starts = ["2026-01-03", "2026-01-01", "2026-01-05", "2026-01-02", "2026-01-04"];
    for (const [i, day] of starts.entries()) {
      await seedSession(kv, `s${i}`, `${day}T00:00:00.000Z`, [
        { type: "error", title: "Build failed", files: ["src/build.ts"] },
      ]);
    }

    const { patterns: found } = await patterns({ limit: 3 });
    const repeat = found.find((p) => p.type === "error_repeat");
    expect(repeat?.sessions.sort()).toEqual(["s0", "s2", "s4"]);
  });

  it("defaults to the 50 most recent Sessions", async () => {
    const { kv, patterns } = setup();
    for (let i = 0; i < 55; i++) {
      const startedAt = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString();
      await seedSession(kv, `s${i}`, startedAt, [{ type: "error", title: "Build failed", files: ["src/build.ts"] }]);
    }

    const { patterns: found } = await patterns({});
    const repeat = found.find((p) => p.type === "error_repeat");
    expect(repeat?.sessions).toHaveLength(50);
    expect(repeat?.sessions).not.toContain("s0");
  });
});

describe("mem::patterns per-Session file cap", () => {
  async function seedWide(kv: ReturnType<typeof mockKV>, uniquePerSession: number) {
    for (const id of ["a", "b", "c"]) {
      const files = Array.from(
        { length: uniquePerSession },
        (_, i) => `${id}/f${String(i).padStart(2, "0")}.ts`,
      );
      await seedSession(kv, id, "2026-01-01T00:00:00.000Z", [
        { type: "file_edit", title: "edit", files: [...files, "z/one.ts", "z/two.ts"] },
      ]);
    }
  }

  it("pairs only the first 50 distinct files of a Session", async () => {
    const { kv, patterns } = setup();
    await seedWide(kv, 50);
    const { patterns: found } = await patterns({});
    expect(found.filter((p) => p.type === "co_change")).toEqual([]);
  });

  it("still pairs files that fall inside the first 50", async () => {
    const { kv, patterns } = setup();
    await seedWide(kv, 48);
    const { patterns: found } = await patterns({});
    expect(found.find((p) => p.type === "co_change")?.files).toEqual([
      "z/one.ts",
      "z/two.ts",
    ]);
  });
});

describe("patterns limit at the boundary", () => {
  function apiSurface() {
    const sdk = mockSdk();
    const received: unknown[] = [];
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    sdk.functions.set("mem::patterns", (data: unknown) => {
      received.push(data);
      return { patterns: [] };
    });
    const call = (body: unknown) =>
      sdk.functions.get("api::patterns")!({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      });
    return { call, received };
  }

  function mcpSurface() {
    const sdk = mockSdk();
    const received: unknown[] = [];
    registerMcpEndpoints(sdk as never, mockKV() as never, SECRET);
    sdk.functions.set("mem::patterns", (data: unknown) => {
      received.push(data);
      return { patterns: [] };
    });
    const call = (args: Record<string, unknown>) =>
      sdk.functions.get("mcp::tools::call")!({
        headers: { authorization: `Bearer ${SECRET}` },
        body: { name: "memory_patterns", arguments: args },
      });
    return { call, received };
  }

  it("REST forwards only project and limit", async () => {
    const { call, received } = apiSurface();
    const res = await call({ project: "proj", limit: 120, extra: "dropped" });
    expect(res.status_code).toBe(200);
    expect(received).toEqual([{ project: "proj", limit: 120 }]);
  });

  it("MCP forwards limit", async () => {
    const { call, received } = mcpSurface();
    const res = await call({ project: "proj", limit: 120 });
    expect(res.status_code).toBe(200);
    expect(received).toEqual([{ project: "proj", limit: 120 }]);
  });

  it.each([0, 501, 2.5, -1, "50", "abc"])("rejects limit %j", async (limit) => {
    const rest = apiSurface();
    const restRes = await rest.call({ limit });
    expect(restRes.status_code).toBe(400);
    expect(rest.received).toEqual([]);

    const mcp = mcpSurface();
    const mcpRes = await mcp.call({ limit });
    expect(mcpRes.status_code).toBe(400);
    expect(mcp.received).toEqual([]);
  });
});
