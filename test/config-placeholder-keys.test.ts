import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "AGENTMEMORY_ALLOW_AGENT_SDK",
  "OPENAI_API_KEY_FOR_LLM",
];

describe("LLM provider detection ignores placeholder keys", () => {
  const original = { ...process.env };

  beforeEach(() => {
    for (const k of KEYS) process.env[k] = "";
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...original };
    vi.restoreAllMocks();
  });

  async function detect() {
    vi.resetModules();
    const config = await import("../src/config.js");
    return { provider: config.loadConfig().provider.provider, kind: config.detectLlmProviderKind() };
  }

  it("selects no provider for a placeholder-only key", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-...";
    expect(await detect()).toEqual({ provider: "noop", kind: "noop" });
  });

  it("reports SDK fallback as LLM without repeating boot warnings", async () => {
    process.env["AGENTMEMORY_ALLOW_AGENT_SDK"] = "true";
    vi.resetModules();
    const config = await import("../src/config.js");
    expect(config.detectLlmProviderKind()).toBe("llm");
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(config.loadConfig().provider.provider).toBe("agent-sdk");
  });

  it("rejects shipped literal placeholders and uses the Google alias", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-...";
    process.env["GEMINI_API_KEY"] = "...";
    expect(await detect()).toEqual({ provider: "noop", kind: "noop" });
    process.env["GOOGLE_API_KEY"] = "google-test-key";
    expect(await detect()).toEqual({ provider: "gemini", kind: "llm" });
  });

  it("selects a provider for a real key", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-real-key-value";
    expect(await detect()).toEqual({ provider: "anthropic", kind: "llm" });
  });
});
