import { platform } from "node:os";
import * as p from "@clack/prompts";
import { installClaudeCode, type ConnectOptions } from "./claude-code.js";

export const CONNECT_ALIAS = "claude-code";

export const CONNECT_FLAGS: Record<string, string> = {
  "--dry-run": "show what would change in ~/.claude.json, write nothing",
  "--force": "rewrite the agentmemory entry even if already wired",
};

export const CONNECT_USAGE = `agentmemory connect ${Object.keys(CONNECT_FLAGS)
  .map((f) => `[${f}]`)
  .join(" ")}`;

export function parseConnectArgs(args: string[]): ConnectOptions {
  const opts: ConnectOptions = { dryRun: false, force: false };
  for (const a of args) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. \`agentmemory connect\` accepts only ${Object.keys(CONNECT_FLAGS).join(" and ")}.`,
      );
    } else if (a.toLowerCase() !== CONNECT_ALIAS) {
      throw new Error(`Unknown agent: ${a}. Claude Code is the only supported host.`);
    }
  }
  return opts;
}

export async function runConnect(args: string[]): Promise<void> {
  p.intro("agentmemory connect");

  let opts: ConnectOptions;
  try {
    opts = parseConnectArgs(args);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(`Usage: ${CONNECT_USAGE}`);
    process.exit(1);
  }

  if (platform() === "win32") {
    p.log.warn(
      "Windows: automated `connect` is not supported yet. Install the Claude Code plugin from the possiblyneal/agentmemory-sqlite marketplace instead.",
    );
    p.outro("Windows: manual install required — see docs");
    return;
  }

  const result = await installClaudeCode(opts);
  if (result.kind === "skipped") {
    p.outro(`Claude Code was not wired (${result.reason}).`);
    process.exit(1);
  }
  if (opts.dryRun) {
    p.outro("Dry run: nothing was written.");
    return;
  }
  p.log.info(
    "Next: install agentmemory's 17 skills into Claude Code so it knows when to call the tools:\n  npx skills add possiblyneal/agentmemory-sqlite -y",
  );
  p.outro("Restart Claude Code (or open a new session) to pick up agentmemory.");
}
