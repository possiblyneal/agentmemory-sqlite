import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";
import { createStdioTransport } from "../src/mcp/transport.js";
import { mockKV } from "./helpers/mocks.js";

function mcpSave(args: Record<string, unknown>) {
  const payloads: Record<string, unknown>[] = [];
  const fns = new Map<string, Function>();
  const sdk = {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { payload: Record<string, unknown> }) => {
      payloads.push(input.payload);
      return { success: true };
    },
  };
  registerMcpEndpoints(sdk as never, mockKV() as never, undefined);
  return fns.get("mcp::tools::call")!({
    headers: {},
    body: { name: "memory_save", arguments: args },
  }).then(() => payloads[0]);
}

describe("memory_save over the daemon's MCP endpoint", () => {
  it("keeps array concepts and files", async () => {
    const payload = await mcpSave({ content: "x", concepts: ["auth", "jwt"], files: ["a.ts", "b.ts"] });
    expect(payload).toMatchObject({ concepts: ["auth", "jwt"], files: ["a.ts", "b.ts"] });
  });

  it("keeps comma-separated concepts", async () => {
    const payload = await mcpSave({ content: "x", concepts: "auth, jwt" });
    expect(payload).toMatchObject({ concepts: ["auth", "jwt"] });
  });
});

describe("stdio transport on a closed pipe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exits cleanly on EPIPE from stdout", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const transport = createStdioTransport(async () => ({}));
    transport.start();
    try {
      const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      expect(() => process.stdout.emit("error", err)).not.toThrow();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      transport.stop();
    }
  });
});
