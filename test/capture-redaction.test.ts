import { describe, it, expect, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { DedupMap } from "../src/functions/dedup.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = "ses_redaction";

async function observeToolCall(toolInput: Record<string, unknown>, toolOutput = "ok") {
  const sdk = mockSdk({ looseTrigger: true });
  const kv = mockKV();
  registerObserveFunction(sdk as never, kv as never, new DedupMap());
  await sdk.trigger("mem::observe", {
    sessionId: SESSION,
    project: "/home/user/repo",
    cwd: "/home/user/repo",
    hookType: "post_tool_use",
    timestamp: "2026-11-18T10:00:00.000Z",
    data: { tool_name: "Bash", tool_input: toolInput, tool_output: toolOutput },
  });
  const rows = [...(kv.store.get(KV.observations(SESSION))?.values() ?? [])];
  expect(rows).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

describe("capture redaction keeps the Observation (#435)", () => {
  it("keeps the tool call when a secret assignment ends a string value", async () => {
    const obs = await observeToolCall({ command: "export API_KEY=abc123" });
    expect(obs["toolName"]).toBe("Bash");
    expect(obs["narrative"]).toContain("export");
    expect(JSON.stringify(obs)).not.toContain("abc123");
  });

  it("redacts secrets held as JSON values under secret-named keys", async () => {
    const obs = await observeToolCall({
      password: "hunter2hunter2",
      accessToken: "abcdefghijklmnopqrstuvwxyz0123",
      client_secret: "s3cr3t-value",
      max_tokens: 4096,
    });
    const text = JSON.stringify(obs);
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(text).not.toContain("s3cr3t-value");
    expect(text).toContain("4096");
  });
});

describe("capture redaction of tool output text (#435)", () => {
  it("redacts a token read from a JSON config file", async () => {
    const hex = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const obs = await observeToolCall(
      { file_path: "/home/user/.config/app/server.json" },
      `{\n  "endpoint": "ws://0.0.0.0:6768",\n  "authToken": "${hex}"\n}`,
    );
    expect(obs["toolName"]).toBe("Bash");
    expect(JSON.stringify(obs)).not.toContain(hex);
    expect(JSON.stringify(obs)).toContain("6768");
  });
});
