import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSlotsFunctions } from "../src/functions/slots.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";

// rohitg00/agentmemory#1108: the MCP tools and REST routes forward `project`
// so an Agent's slot call lands in the project it is working in.

const SECRET = "slots-project-secret";
const AUTH = { authorization: `Bearer ${SECRET}` };

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

type Reply = { status_code: number; body: Record<string, unknown> };

function surfaces() {
  const kv = mockKV();
  const sdk = mockSdk();
  registerSlotsFunctions(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never, SECRET);
  registerMcpEndpoints(sdk as never, kv as never, SECRET);
  const call = (id: string, req: Record<string, unknown>): Promise<Reply> =>
    sdk._fns.get(id)!({ headers: AUTH, ...req });
  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      const res = await call("mcp::tools::call", { body: { name, arguments: args } });
      const content = res.body.content as Array<{ text: string }>;
      return JSON.parse(content[0].text) as Record<string, unknown>;
    },
    rest: call,
  };
}

function contentOf(result: Record<string, unknown>): string {
  return (result.slot as { content: string }).content;
}

describe("slot surfaces carry project", () => {
  const ORIGINAL = process.env["AGENTMEMORY_SLOTS"];
  beforeEach(() => {
    process.env["AGENTMEMORY_SLOTS"] = "true";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["AGENTMEMORY_SLOTS"];
    else process.env["AGENTMEMORY_SLOTS"] = ORIGINAL;
  });

  it("MCP slot tools act on the named project's slot", async () => {
    const { callTool } = surfaces();
    await callTool("memory_slot_append", { label: "project_context", text: "alpha-ctx", project: "alpha" });
    await callTool("memory_slot_replace", { label: "project_context", content: "beta-ctx", project: "beta" });
    await callTool("memory_slot_create", { label: "notes", content: "alpha-notes", project: "alpha" });

    expect(contentOf(await callTool("memory_slot_get", { label: "project_context", project: "alpha" }))).toBe("alpha-ctx");
    expect(contentOf(await callTool("memory_slot_get", { label: "project_context", project: "beta" }))).toBe("beta-ctx");

    const listed = await callTool("memory_slot_list", { project: "beta" });
    expect((listed.slots as Array<{ label: string }>).map((s) => s.label)).not.toContain("notes");

    await callTool("memory_slot_delete", { label: "notes", project: "alpha" });
    expect((await callTool("memory_slot_get", { label: "notes", project: "alpha" })).success).toBe(false);
  });

  it("REST slot routes act on the named project's slot", async () => {
    const { rest } = surfaces();
    const append = await rest("api::slot-append", {
      body: { label: "project_context", text: "alpha-ctx", project: "alpha" },
    });
    expect(append.status_code).toBe(200);
    const create = await rest("api::slot-create", { body: { label: "notes", content: "n", project: "alpha" } });
    expect(create.status_code).toBe(201);
    await rest("api::slot-replace", { body: { label: "project_context", content: "beta-ctx", project: "beta" } });

    const getA = await rest("api::slot-get", { query_params: { label: "project_context", project: "alpha" } });
    expect(contentOf(getA.body)).toBe("alpha-ctx");
    const getB = await rest("api::slot-get", { query_params: { label: "project_context", project: "beta" } });
    expect(contentOf(getB.body)).toBe("beta-ctx");

    const listB = await rest("api::slot-list", { query_params: { project: "beta" } });
    expect((listB.body.slots as Array<{ label: string }>).map((s) => s.label)).not.toContain("notes");

    const del = await rest("api::slot-delete", { query_params: { label: "notes", project: "alpha" } });
    expect(del.status_code).toBe(200);
  });
});

describe("MCP slot tools with slots disabled", () => {
  const ORIGINAL = process.env["AGENTMEMORY_SLOTS"];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["AGENTMEMORY_SLOTS"];
    else process.env["AGENTMEMORY_SLOTS"] = ORIGINAL;
  });

  it("answers that slots are not enabled instead of Internal error", async () => {
    delete process.env["AGENTMEMORY_SLOTS"];
    const sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKV() as never, SECRET);
    const res = (await sdk._fns.get("mcp::tools::call")!({
      headers: AUTH,
      body: { name: "memory_slot_list", arguments: {} },
    })) as Reply;
    expect(res.status_code).toBe(503);
    expect(res.body.error).toBe("Memory slots not enabled");
    expect(res.body.flag).toBe("AGENTMEMORY_SLOTS");
  });
});
