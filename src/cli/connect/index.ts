import { platform } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import { adapter as claudeCode } from "./claude-code.js";

export const ADAPTERS: readonly ConnectAdapter[] = [claudeCode];

export function resolveAdapter(name: string): ConnectAdapter | null {
  const lower = name.toLowerCase();
  return ADAPTERS.find((a) => a.name === lower) ?? null;
}

export function knownAgents(): string[] {
  return ADAPTERS.map((a) => a.name);
}

function parseFlags(args: string[]): {
  dryRun: boolean;
  force: boolean;
  all: boolean;
  positional: string[];
} {
  const positional: string[] = [];
  let dryRun = false;
  let force = false;
  let all = false;
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--all") all = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  return { dryRun, force, all, positional };
}

export async function runAdapter(
  adapter: ConnectAdapter,
  opts: ConnectOptions,
): Promise<ConnectResult> {
  if (!adapter.detect()) {
    p.log.warn(
      `${adapter.displayName}: not detected on this machine (skipping).${adapter.docs ? ` Docs: ${adapter.docs}` : ""}`,
    );
    return { kind: "skipped", reason: "not-detected" };
  }
  p.log.step(`Wiring ${adapter.displayName}…`);
  if (adapter.protocolNote) {
    p.log.message(adapter.protocolNote);
  }
  try {
    return await adapter.install(opts);
  } catch (err) {
    p.log.error(
      `${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "skipped", reason: "exception" };
  }
}

export async function runConnect(args: string[]): Promise<void> {
  const { dryRun, force, all, positional } = parseFlags(args);
  if (platform() === "win32") {
    p.intro("agentmemory connect");
    p.log.warn(
      "Windows: automated `connect` is not supported yet. See https://github.com/rohitg00/agentmemory#other-agents for manual install steps.",
    );
    p.outro("Windows: manual install required — see docs");
    return;
  }

  const opts: ConnectOptions = { dryRun, force };

  p.intro("agentmemory connect");

  if (positional.length === 0 && !all) {
    const detected = ADAPTERS.filter((a) => a.detect());
    if (detected.length === 0) {
      p.log.error("No supported agents detected on this machine.");
      p.outro(`Supported: ${knownAgents().join(", ")}`);
      process.exit(1);
    }
    const picked = await p.multiselect<string>({
      message: "Wire agentmemory into which agents?",
      options: detected.map((a) => ({ value: a.name, label: a.displayName })),
      required: true,
    });
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.");
      return;
    }
    const results: { name: string; result: ConnectResult }[] = [];
    for (const name of picked as string[]) {
      const adapter = resolveAdapter(name);
      if (!adapter) continue;
      results.push({ name, result: await runAdapter(adapter, opts) });
    }
    summarize(results);
    return;
  }

  if (all) {
    const detected = ADAPTERS.filter((a) => a.detect());
    if (detected.length === 0) {
      p.log.error("No supported agents detected on this machine.");
      process.exit(1);
    }
    const results: { name: string; result: ConnectResult }[] = [];
    for (const adapter of detected) {
      results.push({
        name: adapter.name,
        result: await runAdapter(adapter, opts),
      });
    }
    summarize(results);
    return;
  }

  const agentName = positional[0]!;
  const adapter = resolveAdapter(agentName);
  if (!adapter) {
    p.log.error(`Unknown agent: ${agentName}`);
    p.outro(`Supported: ${knownAgents().join(", ")}`);
    process.exit(1);
  }

  const result = await runAdapter(adapter, opts);
  summarize([{ name: agentName, result }]);
  if (result.kind === "skipped" && (result as { reason: string }).reason !== "not-detected") {
    process.exit(1);
  }
}

function summarize(
  results: { name: string; result: ConnectResult }[],
): void {
  const lines = results.map(({ name, result }) => {
    switch (result.kind) {
      case "installed":
        return `  ${pc.green("✓")} ${pc.bold(name)}${result.mutatedPath ? ` ${pc.dim("→")} ${pc.cyan(result.mutatedPath)}` : ""}`;
      case "already-wired":
        return `  ${pc.green("✓")} ${pc.bold(name)} ${pc.dim("(already wired)")}`;
      case "skipped":
        return `  ${pc.red("✗")} ${pc.bold(name)} ${pc.dim(`(skipped: ${result.reason})`)}`;
    }
  });
  p.note(lines.join("\n"), "summary");

  const wiredAny = results.some(
    (r) => r.result.kind === "installed" || r.result.kind === "already-wired",
  );
  if (wiredAny) {
    p.log.info(
      "Next: install agentmemory's 17 skills into the same agent(s) so they know when to call the tools:\n  npx skills add possiblyneal/agentmemory-sqlite -y",
    );
  }

  p.outro("Restart any wired agent (or open a new session) to pick up agentmemory.");
}
