import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";

const SECRET = "action-test-secret";

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
      return { success: true };
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

describe("memory_action_create records the creating Agent (rohitg00/agentmemory#1105)", () => {
  it("forwards createdBy", async () => {
    const { callTool, payloads } = surfaces();
    await callTool("memory_action_create", { title: "ship", createdBy: "agent-a" });
    expect(payloads.get("mem::action-create")).toMatchObject({ createdBy: "agent-a" });
  });

  it("accepts agentId as the creator", async () => {
    const { callTool, payloads } = surfaces();
    await callTool("memory_action_create", { title: "ship", agentId: "agent-b" });
    expect(payloads.get("mem::action-create")).toMatchObject({ createdBy: "agent-b" });
  });
});
