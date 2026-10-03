import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldSkipSession } from "../src/hooks/sdk-guard.js";
import { NoopProvider } from "../src/providers/noop.js";

describe("shouldSkipSession — recursion guard and headless skip", () => {
  const KEYS = ["AGENTMEMORY_SDK_CHILD", "AGENTMEMORY_CAPTURE_HEADLESS", "CLAUDE_CODE_ENTRYPOINT"] as const;
  const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("skips when AGENTMEMORY_SDK_CHILD=1", () => {
    process.env.AGENTMEMORY_SDK_CHILD = "1";
    expect(shouldSkipSession()).toBe(true);
  });

  it.each(["sdk-ts", "sdk-py", "sdk-cli"])("skips a headless %s Session by default", (entrypoint) => {
    process.env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
    expect(shouldSkipSession()).toBe(true);
  });

  it("captures an interactive Session", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(shouldSkipSession()).toBe(false);
  });

  it("captures when no entrypoint is set (non-Claude-Code hosts)", () => {
    expect(shouldSkipSession()).toBe(false);
  });

  it("AGENTMEMORY_SDK_CHILD=1 skips an interactive entrypoint too", () => {
    process.env.AGENTMEMORY_SDK_CHILD = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(shouldSkipSession()).toBe(true);
  });

  it("AGENTMEMORY_CAPTURE_HEADLESS=1 captures headless Sessions", () => {
    process.env.AGENTMEMORY_CAPTURE_HEADLESS = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
    expect(shouldSkipSession()).toBe(false);
  });

  it("AGENTMEMORY_CAPTURE_HEADLESS=1 never re-enables the recursion guard", () => {
    process.env.AGENTMEMORY_CAPTURE_HEADLESS = "1";
    process.env.AGENTMEMORY_SDK_CHILD = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    expect(shouldSkipSession()).toBe(true);
  });
});

describe("NoopProvider — no-op fallback when no LLM key present", () => {
  it("reports name 'noop' so callers can detect it and short-circuit", () => {
    const p = new NoopProvider();
    expect(p.name).toBe("noop");
  });

  it("returns empty string for compress and summarize", async () => {
    const p = new NoopProvider();
    await expect(p.compress()).resolves.toBe("");
    await expect(p.summarize()).resolves.toBe("");
  });
});
