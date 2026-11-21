import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall } from "../src/mcp/standalone.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

process.env["AGENTMEMORY_PROJECT_NAME"] = "cwd-project";

describe("memory_save that only reached the local fallback (#447)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
  });

  it("says the daemon never received it", async () => {
    const res = await handleToolCall("memory_save", { content: "keep this" }, new InMemoryKV());
    const body = JSON.parse(res.content[0].text);
    expect(body.localOnly).toBe(true);
    expect(body.message).toMatch(/daemon/);
  });
});
