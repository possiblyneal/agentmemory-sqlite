import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { getClaudeConfigDir, getClaudeJsonPath } from "../../config.js";
import {
  AGENTMEMORY_MCP_BLOCK,
  backupFile,
  logAlreadyWired,
  logBackup,
  logInstalled,
  readJsonSafe,
  writeJsonAtomic,
} from "./util.js";

export type ConnectOptions = {
  dryRun: boolean;
  force: boolean;
};

export type ConnectResult =
  | { kind: "installed"; backupPath?: string }
  | { kind: "already-wired" }
  | { kind: "skipped"; reason: string };

type ClaudeMcpEntry = typeof AGENTMEMORY_MCP_BLOCK;
type ClaudeConfig = {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  [key: string]: unknown;
};

function entryMatches(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (e["command"] !== "npx") return false;
  const args = Array.isArray(e["args"]) ? (e["args"] as string[]) : [];
  return args.includes("@agentmemory/mcp");
}

export async function installClaudeCode(opts: ConnectOptions): Promise<ConnectResult> {
  const claudeDir = getClaudeConfigDir();
  const claudeJson = getClaudeJsonPath();
  if (!existsSync(claudeDir)) {
    p.log.warn(`Claude Code: not detected on this machine (${claudeDir} is missing).`);
    return { kind: "skipped", reason: "not-detected" };
  }
  p.log.step("Wiring Claude Code…");
  p.log.message(
    "→ Using MCP only. Hooks and skills come with the marketplace plugin: /plugin marketplace add possiblyneal/agentmemory-sqlite, then /plugin install agentmemory.",
  );

  const existing = readJsonSafe<ClaudeConfig>(claudeJson);
  const next: ClaudeConfig = existing ? { ...existing } : {};
  const servers: Record<string, ClaudeMcpEntry> = {
    ...((next.mcpServers as Record<string, ClaudeMcpEntry>) ?? {}),
  };

  const alreadyHas = entryMatches(servers["agentmemory"]);
  if (alreadyHas && !opts.force) {
    logAlreadyWired("Claude Code", claudeJson);
    return { kind: "already-wired" };
  }

  if (opts.dryRun) {
    p.log.info(
      `[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcpServers.agentmemory in ${claudeJson}`,
    );
    return { kind: "installed" };
  }

  let backupPath: string | undefined;
  if (existsSync(claudeJson)) {
    backupPath = backupFile(claudeJson, "claude-code");
    logBackup(backupPath);
  } else {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(claudeJson, "{}\n", "utf-8");
  }

  servers["agentmemory"] = AGENTMEMORY_MCP_BLOCK;
  next.mcpServers = servers;
  writeJsonAtomic(claudeJson, next);

  const verify = readJsonSafe<ClaudeConfig>(claudeJson);
  if (!entryMatches(verify?.mcpServers?.["agentmemory"])) {
    p.log.error(
      `Verification failed: ${claudeJson} did not contain mcpServers.agentmemory after write.`,
    );
    return { kind: "skipped", reason: "verification-failed" };
  }

  logInstalled("Claude Code", claudeJson);
  p.log.info(
    "Restart Claude Code (or run `/mcp` inside a session) to pick up the new server.",
  );

  return { kind: "installed", backupPath };
}
