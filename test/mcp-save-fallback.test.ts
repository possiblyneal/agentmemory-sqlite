import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall } from "../src/mcp/standalone.js";
import { resetHandleForTests, setLivezProbe } from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

describe("memory_save local fallback (#447)", () => {
  beforeEach(() => {
    resetHandleForTests();
    vi.stubEnv("AGENTMEMORY_PROJECT_NAME", "cwd-project");
    vi.stubEnv("AGENTMEMORY_URL", "");
    vi.stubEnv("AGENTMEMORY_FORCE_PROXY", "");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }));
  });

  afterEach(() => {
    resetHandleForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["a failed probe", false],
    ["a connection failure after a successful probe", true],
  ])("reports an unconfirmed daemon save after %s", async (_scenario, up) => {
    setLivezProbe(async () => ({ ok: up }));
    const kv = new InMemoryKV();
    const res = await handleToolCall("memory_save", { content: "keep this" }, kv);
    const body = JSON.parse(res.content[0].text);
    expect(body.saved).toBeTruthy();
    expect(await kv.get("mem:memories", body.saved)).not.toBeNull();
    expect(body.localOnly).toBe(true);
    expect(body.message).toContain("returned ID is in the MCP shim's local store only");
    expect(body.message).toContain("daemon save was not confirmed");
    expect(body.message).toContain("check whether the Memory was saved there before saving it again");
    expect(globalThis.fetch).toHaveBeenCalledTimes(up ? 1 : 0);
  });
});
