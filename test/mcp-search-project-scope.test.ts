import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";

// #787: both MCP search tools advertised no project and dropped it, so
// every MCP read was cross-project even though mem::search and
// mem::smart-search already filter by it.

const SECRET = "scope-test-secret";

function surfaces() {
  const fns = new Map<string, Function>();
  const payloads = new Map<string, Record<string, unknown>>();
  const sdk = {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: Record<string, unknown> }) => {
      payloads.set(input.function_id, input.payload ?? {});
      return { results: [] };
    },
  };
  const kv = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
  registerMcpEndpoints(sdk as never, kv as never, SECRET);
  const callTool = (name: string, args: Record<string, unknown>) =>
    fns.get("mcp::tools::call")!({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { name, arguments: args },
    });
  return { callTool, payloads };
}

describe("MCP search tools forward project (#787)", () => {
  it("memory_recall passes project to mem::search", async () => {
    const { callTool, payloads } = surfaces();
    await callTool("memory_recall", { query: "auth", project: " my-project " });
    expect(payloads.get("mem::search")).toMatchObject({ project: "my-project" });
  });

  it("memory_smart_search passes project to mem::smart-search", async () => {
    const { callTool, payloads } = surfaces();
    await callTool("memory_smart_search", { query: "auth", project: "my-project" });
    expect(payloads.get("mem::smart-search")).toMatchObject({ project: "my-project" });
  });

  it.each([
    ["omitted", {}],
    ["blank", { project: "  " }],
  ])("an %s project stays unscoped", async (_, extra) => {
    const { callTool, payloads } = surfaces();
    await callTool("memory_smart_search", { query: "auth", ...extra });
    expect(payloads.get("mem::smart-search")?.project).toBeUndefined();
  });
});

describe("memory_export refusal", () => {
  it("is reported as an MCP error, not a successful export", async () => {
    const fns = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, h: Function) => {
        fns.set(id, h);
      },
      registerTrigger: () => {},
      trigger: async () => ({ success: false, error: "Export is too big", oversized: true, bytes: 1, limitBytes: 0 }),
    };
    const kv = { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] };
    registerMcpEndpoints(sdk as never, kv as never, SECRET);

    const res = await fns.get("mcp::tools::call")!({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { name: "memory_export", arguments: {} },
    });

    expect(res.body).toEqual({ content: [{ type: "text", text: "Export is too big" }], isError: true });
  });
});
