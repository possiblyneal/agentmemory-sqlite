import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A Missed Injection is invisible to the daemon, so the context-injecting
// hooks record it here on the hook host. The daemon's /diagnostics and the
// homelab check read the same file; only dev runs hooks and REST is
// loopback-only, so the host is shared.
export type MissedInjectionHook = "session-start" | "pre-tool-use" | "pre-compact" | "prompt-submit";

export interface MissedInjection {
  at: string;
  hook: MissedInjectionHook;
  reason: string;
}

const MAX_BYTES = 256 * 1024;
const KEEP_ENTRIES = 1000;

export function missedInjectionsPath(): string {
  return join(homedir(), ".agentmemory", "missed-injections.jsonl");
}

export function missReason(err: unknown): string {
  return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connection";
}

export function recordMissedInjection(hook: MissedInjectionHook, reason: string): void {
  try {
    const path = missedInjectionsPath();
    mkdirSync(join(homedir(), ".agentmemory"), { recursive: true });
    const entry: MissedInjection = { at: new Date().toISOString(), hook, reason };
    appendFileSync(path, JSON.stringify(entry) + "\n");
    if (statSync(path).size > MAX_BYTES) {
      const newest = readFileSync(path, "utf-8").trimEnd().split("\n").slice(-KEEP_ENTRIES);
      writeFileSync(path, newest.join("\n") + "\n");
    }
  } catch {
    // Recording must never fail or delay the hook.
  }
}

export function readMissedInjections(): MissedInjection[] {
  let content: string;
  try {
    content = readFileSync(missedInjectionsPath(), "utf-8");
  } catch {
    return [];
  }
  const entries: MissedInjection[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MissedInjection;
      if (typeof parsed.at === "string" && typeof parsed.hook === "string") entries.push(parsed);
    } catch {
      // A torn line from a concurrent append is skipped, not fatal.
    }
  }
  return entries;
}
