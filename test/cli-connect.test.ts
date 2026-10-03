import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CONNECT_USAGE,
  parseConnectArgs,
  runConnect,
} from "../src/cli/connect/index.js";
import type { installClaudeCode } from "../src/cli/connect/claude-code.js";

describe("agentmemory connect — argument parsing", () => {
  it("defaults to a real, non-forced write", () => {
    expect(parseConnectArgs([])).toEqual({ dryRun: false, force: false });
  });

  it("accepts --dry-run and --force", () => {
    expect(parseConnectArgs(["--dry-run", "--force"])).toEqual({ dryRun: true, force: true });
  });

  it("accepts claude-code as an alias, case-insensitively", () => {
    expect(parseConnectArgs(["claude-code"])).toEqual({ dryRun: false, force: false });
    expect(parseConnectArgs(["Claude-Code", "--force"])).toEqual({ dryRun: false, force: true });
  });

  it.each(["--all", "--with-hooks", "--no-guidelines", "-x"])("rejects the unknown flag %s", (flag) => {
    expect(() => parseConnectArgs([flag])).toThrow(`Unknown flag: ${flag}`);
  });

  it("rejects any other agent name and names Claude Code as the only host", () => {
    expect(() => parseConnectArgs(["cursor"])).toThrow(
      "Unknown agent: cursor. Claude Code is the only supported host.",
    );
  });

  it("documents both flags in the usage line", () => {
    expect(CONNECT_USAGE).toBe("agentmemory connect [--dry-run] [--force]");
  });

  it("exits 1 on an unknown flag without touching ~/.claude.json", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(runConnect(["--all"])).rejects.toThrow("exit 1");
    } finally {
      exit.mockRestore();
    }
  });
});

describe("agentmemory connect — claude-code adapter (mock filesystem)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-connect-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadInstall(): Promise<typeof installClaudeCode> {
    const mod = await import("../src/cli/connect/claude-code.js?t=" + Date.now());
    return (mod as { installClaudeCode: typeof installClaudeCode }).installClaudeCode;
  }

  it("skips with not-detected when ~/.claude doesn't exist", async () => {
    const install = await loadInstall();
    expect(await install({ dryRun: false, force: false })).toEqual({
      kind: "skipped",
      reason: "not-detected",
    });
    expect(existsSync(join(tmpHome, ".claude.json"))).toBe(false);
  });

  it("a dry run writes nothing and stops before the post-install steps", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const { runConnect: freshRunConnect } = await import("../src/cli/connect/index.js");
    const printed: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    }) as never);
    try {
      await freshRunConnect(["--dry-run"]);
    } finally {
      write.mockRestore();
    }
    const output = printed.join("");
    expect(existsSync(join(tmpHome, ".claude.json"))).toBe(false);
    expect(output).toContain("Dry run: nothing was written.");
    expect(output).not.toContain("Restart Claude Code");
    expect(output).not.toContain("skills add");
  });

  it("install() writes mcpServers.agentmemory into ~/.claude.json and is idempotent", async () => {
    const claudeDir = join(tmpHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );

    const install = await loadInstall();

    const first = await install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(readFileSync(join(tmpHome, ".claude.json"), "utf-8"));
    expect(config.mcpServers.agentmemory.command).toBe("npx");
    expect(config.mcpServers.agentmemory.args).toContain("@agentmemory/mcp");
    expect(config.mcpServers.other.command).toBe("x");

    const second = await install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("install() writes env passthrough block for AGENTMEMORY_URL + AGENTMEMORY_SECRET (#375)", async () => {
    // Remote deployments (k8s, reverse proxy) set AGENTMEMORY_URL +
    // AGENTMEMORY_SECRET in the shell. The wired MCP entry must honour
    // those via ${VAR} expansion so a single entry covers both local
    // and remote without the user needing to add a duplicate config
    // that triggers a /doctor duplicate-server warning.
    const claudeDir = join(tmpHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(tmpHome, ".claude.json"), JSON.stringify({}));

    const install = await loadInstall();
    const result = await install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(readFileSync(join(tmpHome, ".claude.json"), "utf-8"));
    const entry = config.mcpServers.agentmemory;
    expect(entry.env).toBeDefined();
    // env interpolation must carry a default so Claude Code
    // doesn't silently drop the server when the user hasn't exported
    // AGENTMEMORY_URL / AGENTMEMORY_SECRET. Defaults match the
    // documented runtime (localhost:3111, no auth, all tools).
    expect(entry.env.AGENTMEMORY_URL).toBe(
      "${AGENTMEMORY_URL:-http://localhost:3111}",
    );
    expect(entry.env.AGENTMEMORY_SECRET).toBe("${AGENTMEMORY_SECRET:-}");
    expect(entry.env.AGENTMEMORY_TOOLS).toBe("${AGENTMEMORY_TOOLS:-all}");
  });

  it("install() with --force re-writes even when already wired", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          agentmemory: { command: "npx", args: ["-y", "@agentmemory/mcp"] },
        },
      }),
    );

    const install = await loadInstall();
    const result = await install({ dryRun: false, force: true });
    expect(result.kind).toBe("installed");
  });

  it("install() with --dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const before = JSON.stringify({ mcpServers: {} });
    writeFileSync(join(tmpHome, ".claude.json"), before);

    const install = await loadInstall();
    const result = await install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");

    const after = readFileSync(join(tmpHome, ".claude.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("install() creates a backup file under ~/.agentmemory/backups/", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    const install = await loadInstall();
    const result = await install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.backupPath!).toContain(join(".agentmemory", "backups"));
    }
  });
});
