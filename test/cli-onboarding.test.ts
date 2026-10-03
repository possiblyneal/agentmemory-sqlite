import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prompts = vi.hoisted(() => ({
  note: vi.fn(),
  multiselect: vi.fn(async () => {
    throw new Error("interactive multiselect should not run in non-TTY onboarding");
  }),
  select: vi.fn(async () => {
    throw new Error("interactive select should not run in non-TTY onboarding");
  }),
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => prompts);
const installClaudeCode = vi.hoisted(() => vi.fn(async () => ({ kind: "installed" })));
vi.mock("../src/cli/connect/claude-code.js", () => ({ installClaudeCode }));

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const ORIGINAL_CI = process.env["CI"];
const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

let sandboxHome: string;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function restoreTTY(): void {
  if (stdinTtyDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
  else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  if (stdoutTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
  else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
}

async function freshOnboarding() {
  vi.resetModules();
  return await import("../src/cli/onboarding.js");
}

describe("cli onboarding", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-onboarding-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    delete process.env["CI"];
    setTTY(false);
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreTTY();
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    if (ORIGINAL_CI === undefined) delete process.env["CI"];
    else process.env["CI"] = ORIGINAL_CI;
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("does not prompt and records default preferences when onboarding runs without a TTY", async () => {
    const { runOnboarding } = await freshOnboarding();

    const result = await runOnboarding();

    expect(result).toEqual({ provider: null });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();

    const preferencesPath = join(sandboxHome, ".agentmemory", "preferences.json");
    expect(existsSync(preferencesPath)).toBe(true);
    const preferences = JSON.parse(readFileSync(preferencesPath, "utf-8"));
    expect(preferences).toMatchObject({
      schemaVersion: 1,
      lastProvider: null,
      skipSplash: true,
    });
    expect(typeof preferences.firstRunAt).toBe("string");
  });

  it.each(["true", "1"])("does not prompt on a TTY when CI=%s", async (ci) => {
    setTTY(true);
    process.env["CI"] = ci;
    const { runOnboarding } = await freshOnboarding();

    await runOnboarding();

    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(installClaudeCode).not.toHaveBeenCalled();
  });

  it.each(["", "0", "false"])("still prompts on a TTY when CI=%j", async (ci) => {
    setTTY(true);
    process.env["CI"] = ci;
    prompts.select.mockResolvedValueOnce("skip");
    const { runOnboarding } = await freshOnboarding();

    await runOnboarding();

    expect(prompts.confirm).toHaveBeenCalled();
  });

  it("offers to wire Claude Code without asking which agents to use", async () => {
    setTTY(true);
    prompts.select.mockResolvedValueOnce("skip");
    const { runOnboarding } = await freshOnboarding();

    const result = await runOnboarding();

    expect(result).toEqual({ provider: null });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(installClaudeCode).toHaveBeenCalledOnce();
    expect(installClaudeCode).toHaveBeenCalledWith({ dryRun: false, force: false });
  });

  it("defaults the wiring offer to no, since the marketplace plugin registers the MCP server", async () => {
    setTTY(true);
    prompts.select.mockResolvedValueOnce("skip");
    const { runOnboarding } = await freshOnboarding();

    await runOnboarding();

    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Wire Claude Code"), initialValue: false }),
    );
  });

  it("leaves Claude Code unwired when the offer is declined", async () => {
    setTTY(true);
    prompts.select.mockResolvedValueOnce("skip");
    prompts.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const { runOnboarding } = await freshOnboarding();

    await runOnboarding();

    expect(installClaudeCode).not.toHaveBeenCalled();
  });
});
