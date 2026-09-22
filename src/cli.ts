#!/usr/bin/env node

import { spawn, execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";

// Semantic color helpers. clack strips ANSI for box-width math
// (stripVTControlCharacters + string-width), so coloring inside p.note
// keeps borders aligned. Centralized here so the palette stays consistent
// across every command's output.
const c = {
  url: pc.cyan,
  ok: pc.green,
  warn: pc.yellow,
  err: pc.red,
  cmd: (s: string) => pc.bold(pc.cyan(s)),
  label: pc.bold,
  dim: pc.dim,
  accent: (s: string) => pc.bold(pc.yellow(s)),
};
import { generateId } from "./state/schema.js";
import {
  buildDiagnostics,
  dryRunPlan,
  parseEnvFile,
  type Diagnostic,
  type DiagnosticFixResult,
  type DoctorContext,
  type DoctorEffects,
} from "./cli/doctor-diagnostics.js";
import {
  buildRemovePlan,
  formatPlan,
  type ConnectManifest,
  type RemoveOptions,
} from "./cli/remove-plan.js";
import { renderSplash } from "./cli/splash.js";
import { isFirstRun, readPrefs, resetPrefs, writePrefs } from "./cli/preferences.js";
import { runOnboarding } from "./cli/onboarding.js";
import { setBootVerbose } from "./logger.js";
import { hydrateProcessEnvFromFile } from "./config.js";
import { VERSION } from "./version.js";
import { getAllTools, ESSENTIAL_TOOLS } from "./mcp/tools-registry.js";
import { knownAgents } from "./cli/connect/index.js";

const ALL_TOOLS_COUNT = getAllTools().length;
const CORE_TOOLS_COUNT = getAllTools().filter((t) => ESSENTIAL_TOOLS.has(t.name)).length;
import { resolveDataDir } from "./cli-data-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const IS_WINDOWS = platform() === "win32";
const IS_VERBOSE =
  args.includes("--verbose") ||
  args.includes("-v") ||
  process.env["AGENTMEMORY_VERBOSE"] === "1" ||
  process.env["AGENTMEMORY_VERBOSE"] === "true";

// Propagate the resolved verbosity to the worker's boot logger so the
// 25-line `[agentmemory] X registered` stream is either dropped or
// printed verbatim. Without this the worker's default (env-only) would
// disagree with the CLI flag.
setBootVerbose(IS_VERBOSE);

const IS_RESET = args.includes("--reset");

// Fold ~/.agentmemory/.env into process.env before any port/URL read
// (getRestPort/getBaseUrl/getStreamPort) or the --port /
// --instance / --tools handlers below. Only-if-unset, so a real
// process.env value — including one just set by a CLI flag — still wins.
hydrateProcessEnvFromFile();

// --version / -V early exit. Print VERSION + exit before any side effects
// (engine boot, env load, dir mkdir). `-v` is taken by --verbose so we
// reserve `-V` (capital) for version per POSIX convention.
if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

function vlog(msg: string): void {
  if (IS_VERBOSE) p.log.info(`[verbose] ${msg}`);
}

function wrapList(items: readonly string[], indent: number, width = 78): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const joined = line ? `${line}, ${item}` : item;
    if (line && indent + joined.length > width) {
      lines.push(`${line},`);
      line = item;
    } else {
      line = joined;
    }
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(indent)}`);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
agentmemory — persistent memory for AI coding agents

Usage: agentmemory [command] [options]

Commands:
  (default)          Start agentmemory worker
  init               Copy bundled .env.example to ~/.agentmemory/.env if absent
  connect [agent]    Wire agentmemory into an installed agent
                     (${wrapList(knownAgents(), 21)}).
                     No arg = interactive picker. --all wires every detected agent.
                     --dry-run shows what would change. --force re-installs.
  status             Show connection status, memory count, flags, and health
  doctor             Interactive diagnostic + fixer. [F]ix · [S]kip · [?]more · [Q]uit
                     --all: apply every fix without prompting (CI)
                     --dry-run: show what each fix would do, don't execute
  remove             Cleanly uninstall agentmemory (pidfile, .env, data).
                     --force: skip confirmations · --keep-data: keep memory data
  demo [--serve]     Seed sample sessions and show recall in action.
                     --serve boots the server, runs the demo, and stops it
                     in one command (no second terminal).
  upgrade            Upgrade local deps (best effort)
  stop [--force]     Stop the running daemon started by this CLI.
                     --force also signals processes holding the REST port that
                     the pidfile does not claim (use when the pidfile is gone).
  mcp                Start standalone MCP shim — opt-in surface for MCP-only clients
                     (Cursor, Gemini CLI, etc). REST always available at :3111.
  import-jsonl [p]   Import Claude Code JSONL transcripts (default: ~/.claude/projects)
                     --max-files <N> | --max-files=<N>: override scan cap (default 200, max 1000;
                     out-of-range is rejected; for trees >1000 files, batch by subdirectory)

Options:
  --help, -h         Show this help
  --verbose, -v      Show the boot log and diagnostic info
  --reset            Wipe ~/.agentmemory/preferences.json and re-run onboarding
  --tools all|core   Tool visibility (default: all = ${ALL_TOOLS_COUNT} tools; core = ${CORE_TOOLS_COUNT} essentials)
  --port <N>         Override REST port (default: 3111). Streams (N+1) and
                     viewer (N+2) auto-derive from N so a single flag
                     relocates the whole trio.
  --instance <N>     Shortcut for --port (3111 + N*100) to run multiple
                     daemons side-by-side without env gymnastics.
                     --instance 1 -> 3211/3212/3213, etc. (max N=50)
  --data-dir <path>  Store the SQLite state outside the current repo

Environment:
  AGENTMEMORY_URL              Full REST base URL (e.g. http://localhost:3111).
                               Honored by status, doctor, and MCP shim commands.
  AGENTMEMORY_DATA_DIR         State directory fallback when --data-dir is not set.
  AGENTMEMORY_FOLLOWUP_WINDOW_SECONDS
                               Window (seconds) for the smart-search follow-up diagnostic
                               (default 30). Long values overcount, short values undercount.

Quick start:
  agentmemory          # start the daemon
  agentmemory demo     # see semantic recall in 30 seconds
  agentmemory doctor   # diagnose config + feature flags
  agentmemory status   # health + memory count + flags
  agentmemory upgrade  # upgrade agentmemory
  agentmemory mcp      # standalone MCP server
  npx @agentmemory/mcp # same as above (shim package, proxies to this server)
`);
  process.exit(0);
}

const toolsIdx = args.indexOf("--tools");
if (toolsIdx !== -1 && args[toolsIdx + 1]) {
  const toolsMode = args[toolsIdx + 1]!;
  if (toolsMode !== "all" && toolsMode !== "core") {
    p.log.warn(
      `Unknown --tools value "${toolsMode}" (valid: all, core); falling back to all.`,
    );
  }
  process.env["AGENTMEMORY_TOOLS"] = toolsMode;
}

const portIdx = args.indexOf("--port");
if (portIdx !== -1 && args[portIdx + 1]) {
  process.env["III_REST_PORT"] = args[portIdx + 1];
}

// `--instance N` picks a 100-port block off the 3111 base so multiple
// agentmemory daemons can coexist on one host without env-var
// gymnastics. `--instance 0` keeps the canonical 3111/3112/3113 trio;
// `--instance 1` → 3211/3212/3213; etc. REST acts as the
// anchor — streams/viewer derive from it via fixed offsets below unless
// an env explicitly pins each one.
const instanceIdx = args.indexOf("--instance");
if (instanceIdx !== -1 && args[instanceIdx + 1]) {
  const n = parseInt(args[instanceIdx + 1] || "", 10);
  if (Number.isFinite(n) && n >= 0 && n <= 50) {
    const base = 3111 + n * 100;
    if (!process.env["III_REST_PORT"]) {
      process.env["III_REST_PORT"] = String(base);
    }
  }
}

const dataDirResolution = resolveDataDir({ args });
if (dataDirResolution.source !== "default") {
  process.env["AGENTMEMORY_DATA_DIR"] = dataDirResolution.dataDir;
}

function getRestPort(): number {
  const url = process.env["AGENTMEMORY_URL"];
  if (url) {
    try {
      const parsed = new URL(url).port;
      if (parsed) return parseInt(parsed, 10);
    } catch {}
  }
  return parseInt(process.env["III_REST_PORT"] || "3111", 10) || 3111;
}

function getBaseUrl(): string {
  const url = process.env["AGENTMEMORY_URL"];
  if (url) return url.replace(/\/+$/, "");
  return `http://localhost:${getRestPort()}`;
}

let discoveredViewerPort: number | null = null;

export async function discoverViewerPort(): Promise<void> {
  if (discoveredViewerPort !== null) return;
  try {
    const res = await fetch(`${getBaseUrl()}/agentmemory/livez`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = await res.json() as { viewerPort?: number | null };
      if (typeof data.viewerPort === "number") {
        discoveredViewerPort = data.viewerPort;
      }
    }
  } catch {}
}

function getViewerUrl(): string {
  const envUrl = process.env["AGENTMEMORY_VIEWER_URL"];
  if (envUrl) return envUrl.replace(/\/+$/, "");
  
  if (discoveredViewerPort !== null) {
    try {
      const u = new URL(getBaseUrl());
      return `${u.protocol}//${u.hostname}:${discoveredViewerPort}`;
    } catch {
      return `http://localhost:${discoveredViewerPort}`;
    }
  }
  
  try {
    const u = new URL(getBaseUrl());
    const vPort =
      parseInt(process.env["III_VIEWER_PORT"] || "", 10) ||
      (parseInt(u.port || "3111", 10) || 3111) + 2;
    return `${u.protocol}//${u.hostname}:${vPort}`;
  } catch {
    const vPort =
      parseInt(process.env["III_VIEWER_PORT"] || "", 10) ||
      getRestPort() + 2;
    return `http://localhost:${vPort}`;
  }
}

// WebSocket streams port. Engine writes here; the SDK and viewer
// subscribe. Honors both `III_STREAM_PORT` (the singular name the
// engine docs use post-0.11) and `III_STREAMS_PORT` (the name our
// own config.ts has used since 0.7) so a single source of truth in
// either form lights up the ready panel. Falls back to REST+1 so
// `--port 3211` auto-picks 3212 instead of colliding on 3112.
function getStreamPort(): number {
  return (
    parseInt(process.env["III_STREAM_PORT"] || "", 10) ||
    parseInt(process.env["III_STREAMS_PORT"] || "", 10) ||
    getRestPort() + 1
  );
}

// Liveness probe for the running daemon: any HTTP answer on the REST port
// means the in-process runtime is up.
async function isDaemonRunning(): Promise<boolean> {
  try {
    await fetch(`${getBaseUrl()}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}

async function isAgentmemoryReady(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/agentmemory/livez`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    try {
      const data = await res.json() as { viewerPort?: number | null; viewerSkipped?: boolean };
      if (typeof data.viewerPort === "number") {
        discoveredViewerPort = data.viewerPort;
        return true;
      }
      if (data.viewerSkipped) return true;
      return false;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function warnIfRelocatedDataDir(): void {
  if (!dataDirResolution.relocatedFrom) return;

  try {
    mkdirSync(dataDirResolution.dataDir, { recursive: true });
    const marker = join(dataDirResolution.dataDir, ".cwd-relocation-warning");
    if (existsSync(marker)) return;
    p.log.warn(
      `Default data dir ${dataDirResolution.relocatedFrom} is inside a git worktree; using ${dataDirResolution.dataDir} instead.`,
    );
    writeFileSync(marker, new Date().toISOString());
  } catch {
    p.log.warn(
      `Default data dir ${dataDirResolution.relocatedFrom} is inside a git worktree; using ${dataDirResolution.dataDir} instead.`,
    );
  }
}

function whichBinary(name: string): string | null {
  const cmd = IS_WINDOWS ? "where" : "which";
  try {
    const out = execFileSync(cmd, [name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}


// Worker pidfile: the daemon writes its own pid here from src/index.ts on
// boot. It is the only positive identity `agentmemory stop` and
// `agentmemory doctor` have, since the daemon is otherwise a plain `node`
// process indistinguishable from anything else holding the REST port.
function workerPidfilePath(): string {
  return join(homedir(), ".agentmemory", "worker.pid");
}

function readWorkerPidfile(): number | null {
  try {
    const pidStr = readFileSync(workerPidfilePath(), "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearWorkerPidfile(): void {
  try {
    unlinkSync(workerPidfilePath());
  } catch {}
}

async function waitForAgentmemoryReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isAgentmemoryReady()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Derive a host string for the streams WebSocket line from the REST base
// (`AGENTMEMORY_URL`) so a remote-bind setup doesn't print misleading
// localhost addresses. Falls back to localhost.
function getStreamHost(): string {
  const raw = process.env["AGENTMEMORY_URL"];
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname) return parsed.hostname;
    } catch {}
  }
  return "localhost";
}

function printReadyHint(): void {
  // REST goes through getBaseUrl which already honors AGENTMEMORY_URL
  // for full host+protocol overrides. Streams is derived from the same
  // host so a remote bind reads correctly in the panel.
  const restUrl = getBaseUrl();
  const viewerUrl = getViewerUrl();
  const streamUrl = `ws://${getStreamHost()}:${getStreamPort()}`;

  const lines = [
    `${c.label("REST API")}     ${c.url(restUrl)}`,
    `${c.label("Viewer")}       ${c.url(viewerUrl)}`,
    `${c.label("Streams")}      ${c.url(streamUrl)}`,
  ];
  // p.note renders a bordered panel with a title — same affordance
  // used elsewhere in this CLI for "Troubleshooting" / "Setup
  // required" blocks, so the visual language stays consistent.
  p.note(lines.join("\n"), `agentmemory v${c.accent(VERSION)}`);

  process.stdout.write(`\n${c.dim("Try:")} ${c.cmd("agentmemory demo")}\n`);
}

async function main() {
  // Booting a second instance next to a live daemon would race it for the
  // REST, streams and viewer ports and leave both half-bound. Refuse
  // instead. A different --instance resolves to a different port block, so
  // multi-instance setups are unaffected.
  try {
    const probe = await fetch(`${getBaseUrl()}/agentmemory/livez`, {
      signal: AbortSignal.timeout(1500),
    });
    if (probe.ok) {
      p.log.error(
        `agentmemory is already running on port ${getRestPort()}. Starting a second instance here would corrupt the running daemon's REST routing. Use the REST API (or the MCP tools) against the running instance, run a different --instance, or stop it first with \`agentmemory stop\`.`,
      );
      process.exit(1);
    }
  } catch {
    // no live daemon on this port; boot normally
  }

  // `--reset` wipes preferences before anything else so the onboarding
  // flow below always runs fresh.
  if (IS_RESET) {
    resetPrefs();
  }

  const firstRun = isFirstRun();
  const prefs = readPrefs();
  // Show the splash on the first run, on --reset, or whenever the user
  // hasn't yet opted out via the schema (we set `skipSplash: true`
  // after onboarding completes). Verbose runs always splash since the
  // user explicitly asked for the chatty experience.
  if (firstRun || IS_RESET || IS_VERBOSE || !prefs.skipSplash) {
    renderSplash(VERSION);
  }

  if (firstRun || IS_RESET) {
    await runOnboarding();
  }

  warnIfRelocatedDataDir();

  // There is nothing to check, download, pin, adopt or configure: the
  // runtime is in-process and src/index.ts binds the REST and stream
  // ports itself (ADR 0001). Importing it IS starting the daemon.
  await import("./index.js");
  if (await waitForAgentmemoryReady(15000)) {
    printReadyHint();
  }
  // Mark splash as something to skip on subsequent runs. This is a
  // no-op if onboarding already flipped the flag (idempotent merge).
  writePrefs({ skipSplash: true });
}

async function apiFetch<T = unknown>(base: string, path: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const headers: Record<string, string> = {};
    const secret = process.env["AGENTMEMORY_SECRET"];
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    const res = await fetch(`${base}/agentmemory/${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function runStatus() {
  const base = getBaseUrl();
  p.intro("agentmemory status");

  const up = await isDaemonRunning();
  if (!up) {
    p.log.error(`Not running — no response at ${base}`);
    p.log.info("Start with: npx @agentmemory/agentmemory");
    process.exit(1);
  }

  try {
    const [healthRes, sessionsRes, graphRes, memoriesRes, flagsRes, followupRes] = await Promise.all([
      apiFetch<any>(base, "health"),
      apiFetch<any>(base, "sessions?limit=all"),
      apiFetch<any>(base, "graph/stats"),
      apiFetch<any>(base, "memories?count=true"),
      apiFetch<any>(base, "config/flags"),
      apiFetch<any>(base, "diagnostics/followup"),
    ]);

    if (typeof healthRes?.viewerPort === "number") {
      discoveredViewerPort = healthRes.viewerPort;
    }
    const h = healthRes?.health;
    const status = healthRes?.status || "unknown";
    const version = healthRes?.version || "?";
    const sessionList = Array.isArray(sessionsRes?.sessions) ? sessionsRes.sessions : [];
    const sessions = sessionList.length;
    const nodes = Number(graphRes?.totalNodes ?? graphRes?.nodes ?? graphRes?.nodeCount ?? 0);
    const edges = Number(graphRes?.totalEdges ?? graphRes?.edges ?? graphRes?.edgeCount ?? 0);
    const cb = healthRes?.circuitBreaker?.state || "closed";
    const heapMB = h?.memory ? Math.round(h.memory.heapUsed / 1048576) : 0;
    const uptime = h?.uptimeSeconds ? Math.round(h.uptimeSeconds) : 0;

    const obsCount = sessionList.reduce(
      (sum: number, s: any) => sum + (Number(s?.observationCount) || 0),
      0,
    );
    const memCount = Number(memoriesRes?.latestCount ?? memoriesRes?.total ?? 0) || 0;
    const estFullTokens = obsCount * 80;
    const estInjectedTokens = Math.min(obsCount, 50) * 38;
    const tokensSaved = estFullTokens - estInjectedTokens;
    const pctSaved = estFullTokens > 0 ? Math.round((tokensSaved / estFullTokens) * 100) : 0;

    p.log.success(`Connected — v${version} at ${base}`);

    const lines = [
      `Health:       ${status === "healthy" ? pc.green("✓ healthy") : pc.yellow(status)}`,
      `Sessions:     ${sessions}`,
      `Observations: ${obsCount}`,
      `Memories:     ${memCount}`,
      `Graph:        ${nodes} nodes, ${edges} edges`,
      `Circuit:      ${cb}`,
      `Heap:         ${heapMB} MB`,
      `Uptime:       ${uptime}s`,
      `Viewer:       ${c.url(getViewerUrl())}`,
    ];

    if (obsCount > 0) {
      lines.push("");
      lines.push(`Token savings: ~${tokensSaved.toLocaleString()} tokens saved (${pctSaved}% reduction)`);
      lines.push(`  Full context: ~${estFullTokens.toLocaleString()} tokens`);
      lines.push(`  Injected:     ~${estInjectedTokens.toLocaleString()} tokens`);
    }

    if (flagsRes) {
      const provider = flagsRes.provider === "llm" ? pc.green("✓ llm") : pc.yellow("✗ noop (no key)");
      const embed = flagsRes.embeddingProvider === "embeddings" ? pc.green("✓ embeddings") : pc.dim("bm25-only");
      const flagRows = (flagsRes.flags || []).map((f: { key: string; enabled: boolean; label: string }) =>
        `  ${f.enabled ? pc.green("✓") : pc.dim("✗")} ${pc.bold(f.key.padEnd(32))} ${f.label}`
      );
      lines.push("");
      lines.push(`Provider:     ${provider}`);
      lines.push(`Embeddings:   ${embed}`);
      lines.push(`Flags:`);
      flagRows.forEach((r: string) => lines.push(r));
    }

    if (followupRes && Number.isFinite(followupRes.agentInitiatedSearches)) {
      const total = Number(followupRes.agentInitiatedSearches) || 0;
      const hits = Number(followupRes.followupWithinWindow) || 0;
      const pct = total > 0 ? Math.round((hits / total) * 100) : 0;
      lines.push("");
      lines.push(
        `Followup rate: ${hits}/${total} (${pct}%) within ${followupRes.windowSeconds}s — directional, may overcount on refinement`,
      );
    }

    p.note(lines.join("\n"), "agentmemory");
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

type DoctorCheck = { name: string; ok: boolean; hint?: string };

function formatChecks(checks: DoctorCheck[]): string {
  return checks
    .map((c) => `${c.ok ? pc.green("✓") : pc.red("✗")} ${c.name}${c.hint ? `\n   ${c.hint}` : ""}`)
    .join("\n");
}

type CCHooksCheck =
  | { state: "loaded"; manifestPath?: string }
  | { state: "not-loaded" }
  | { state: "no-debug-log" }
  | { state: "no-cc-dir" };

function findLatestDebugLog(debugDir: string): string | undefined {
  const latestLink = join(debugDir, "latest");
  try {
    if (existsSync(latestLink)) {
      const target = readlinkSync(latestLink);
      const resolved = target.startsWith("/") ? target : join(debugDir, target);
      if (existsSync(resolved)) return resolved;
    }
  } catch {}

  try {
    const newest = readdirSync(debugDir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => ({ f, m: statSync(join(debugDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest) return join(debugDir, newest.f);
  } catch {}

  return undefined;
}

function checkClaudeCodeHooks(): CCHooksCheck {
  const debugDir = join(homedir(), ".claude", "debug");
  if (!existsSync(debugDir)) return { state: "no-cc-dir" };

  const logPath = findLatestDebugLog(debugDir);
  if (!logPath) return { state: "no-debug-log" };

  let content: string;
  try {
    content = readFileSync(logPath, "utf8");
  } catch {
    return { state: "no-debug-log" };
  }

  const match = content.match(
    /Loaded hooks from standard location for plugin agentmemory:\s*(\S+)/
  );
  if (match) return { state: "loaded", manifestPath: match[1] };
  if (content.includes("Loading hooks from plugin: agentmemory")) return { state: "loaded" };
  return { state: "not-loaded" };
}

// ---------------------------------------------------------------------------
// Doctor v2 — interactive fixer.
//
// The legacy passive check-list (server reachable, flags, knowledge-graph,
// Claude Code hooks) still runs first as an informational summary because
// those checks need a live daemon and don't have a one-shot inline fix.
// Then we drive the new diagnostic catalog (see src/cli/doctor-diagnostics.ts)
// which prompts Fix/Skip/More/Quit per failing check, applies the fix
// inline, and re-checks only the affected diagnostic.

function buildDoctorContext(): DoctorContext {
  return {
    baseUrl: getBaseUrl(),
    viewerUrl: getViewerUrl(),
    envPath: join(homedir(), ".agentmemory", ".env"),
    pidfilePath: workerPidfilePath(),
  };
}

function buildDoctorEffects(): DoctorEffects {
  return {
    envFileExists: () => existsSync(join(homedir(), ".agentmemory", ".env")),
    readEnvFile: () => {
      try {
        return parseEnvFile(
          readFileSync(join(homedir(), ".agentmemory", ".env"), "utf-8"),
        );
      } catch {
        return {};
      }
    },
    pidfileExists: () => existsSync(workerPidfilePath()),
    pidfilePidIsAlive: () => {
      const pid = readWorkerPidfile();
      if (pid === null) return null;
      return pidAlive(pid);
    },
    viewerReachable: async (timeoutMs = 2000) => {
      try {
        await discoverViewerPort();
        const res = await fetch(getViewerUrl(), {
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    runInit: async () => {
      try {
        await runInit();
        return { ok: true, message: "Wrote ~/.agentmemory/.env" };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    openEditor: async (path: string) => {
      const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
      p.log.info(`Opening ${path} in ${editor}…`);
      try {
        // Inherit stdio so the user actually sees the editor.
        const result = spawnSync(editor, [path], { stdio: "inherit" });
        if (result.error) {
          return {
            ok: false,
            message: `Failed to launch ${editor}: ${result.error.message}`,
          };
        }
        if ((result.status ?? 0) !== 0) {
          return {
            ok: false,
            message: `${editor} exited with code ${result.status}`,
          };
        }
        return { ok: true, message: `Saved ${path}` };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    runStop: async () => {
      try {
        // runStop calls process.exit on its own — guard against that here
        // by short-circuiting when there's nothing to stop.
        const port = getRestPort();
        const portPids = findDaemonPidsByPort(port);
        const pidfilePid = readWorkerPidfile();
        if (portPids.length === 0 && pidfilePid === null) {
          clearWorkerPidfile();
          return { ok: true, message: "Nothing to stop." };
        }
        const candidates = new Set<number>();
        if (pidfilePid) candidates.add(pidfilePid);
        for (const pid of portPids) candidates.add(pid);
        let allStopped = true;
        for (const pid of candidates) {
          const ok = await signalAndWait(pid, "SIGTERM", 3000);
          if (!ok) allStopped = false;
        }
        clearWorkerPidfile();
        return {
          ok: allStopped,
          message: allStopped ? "Daemon stopped." : "Some daemon pids survived.",
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    runStart: async () => {
      // doctor runs in its own process, so starting the daemon means
      // spawning a detached copy of the same entry point main() imports.
      try {
        const entry = join(__dirname, "index.mjs");
        if (!existsSync(entry)) {
          return {
            ok: false,
            message: `Daemon entry point not found at ${entry}. Start it manually: agentmemory`,
          };
        }
        spawn(process.execPath, [entry], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
        const ready = await waitForAgentmemoryReady(15000);
        return {
          ok: ready,
          message: ready ? "Daemon ready" : "Daemon did not become ready within 15s",
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    clearDaemonPidfile: () => {
      clearWorkerPidfile();
    },
  };
}

async function passiveServerChecks(): Promise<DoctorCheck[]> {
  const base = getBaseUrl();
  const checks: DoctorCheck[] = [];

  const serverUp = await isDaemonRunning();
  checks.push({
    name: "Server reachable",
    ok: serverUp,
    hint: serverUp
      ? undefined
      : `Start with: npx @agentmemory/agentmemory (tried ${base})`,
  });
  if (!serverUp) return checks;

  const [health, flags, graph] = await Promise.all([
    apiFetch<any>(base, "health", 3000),
    apiFetch<any>(base, "config/flags", 3000),
    apiFetch<any>(base, "graph/stats", 3000),
  ]);

  const hasLlm = flags?.provider === "llm";
  const hasEmbed = flags?.embeddingProvider === "embeddings";
  const graphNodeCount = Number(
    graph?.totalNodes ?? graph?.nodes ?? graph?.nodeCount ?? 0,
  );
  const graphHas = graphNodeCount > 0;

  checks.push(
    {
      name: "Health status",
      ok: health?.status === "healthy",
      hint:
        health?.status === "healthy"
          ? undefined
          : `Status: ${health?.status || "unknown"}`,
    },
    {
      name: "LLM provider",
      ok: hasLlm,
      hint: hasLlm ? undefined : "set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env",
    },
    {
      name: "Embedding provider",
      ok: hasEmbed,
      hint: hasEmbed
        ? undefined
        : "Running BM25-only. Add OPENAI_API_KEY / VOYAGE_API_KEY / COHERE_API_KEY / OLLAMA_HOST",
    },
  );

  for (const f of (flags?.flags || []) as {
    label: string;
    enabled: boolean;
    enableHow: string;
  }[]) {
    checks.push({
      name: f.label,
      ok: f.enabled,
      hint: f.enabled ? undefined : f.enableHow,
    });
  }

  const cc = checkClaudeCodeHooks();
  const ccCheck = (() => {
    switch (cc.state) {
      case "loaded":
        return {
          ok: true,
          hint: cc.manifestPath ? `manifest: ${cc.manifestPath}` : undefined,
        };
      case "not-loaded":
        return {
          ok: false,
          hint:
            "Plugin enabled but hooks not loaded by Claude Code. Try: /plugin uninstall agentmemory@agentmemory && /plugin install agentmemory@agentmemory, then restart the session.",
        };
      case "no-debug-log":
        return {
          ok: false,
          hint:
            'Cannot verify — no Claude Code debug log found. Run once with `claude --debug -p "x"`, then re-run doctor.',
        };
      case "no-cc-dir":
        return undefined;
    }
  })();
  if (ccCheck) checks.push({ name: "Claude Code plugin hooks registered", ...ccCheck });

  checks.push({
    name: "Knowledge graph populated",
    ok: graphHas,
    hint: graphHas
      ? undefined
      : "Graph is empty. Run a session with GRAPH_EXTRACTION_ENABLED=true.",
  });

  return checks;
}

type DoctorAction = "fix" | "skip" | "more" | "quit";

async function askFixAction(d: Diagnostic): Promise<DoctorAction> {
  const choice = await p.select<DoctorAction>({
    message: `[${d.id}] ${d.message}`,
    options: [
      { value: "fix", label: "F  Fix", hint: d.fixPreview },
      { value: "skip", label: "S  Skip" },
      { value: "more", label: "?  More info" },
      { value: "quit", label: "Q  Quit doctor" },
    ],
    initialValue: "fix",
  });
  if (p.isCancel(choice)) return "quit";
  return choice;
}

async function applyFixWithReport(
  d: Diagnostic,
  ctx: DoctorContext,
  dryRun: boolean,
): Promise<DiagnosticFixResult> {
  if (dryRun) {
    p.log.info(`[dry-run] would: ${d.fixPreview}`);
    return { ok: true, message: "(dry-run)" };
  }
  const result = await d.fix(ctx);
  if (result.ok) {
    p.log.success(result.message ?? `${d.id} fixed.`);
  } else {
    p.log.error(result.message ?? `${d.id} fix failed.`);
  }
  return result;
}

async function runDoctor() {
  p.intro("agentmemory doctor");
  const applyAll = args.includes("--all");
  const dryRun = args.includes("--dry-run");
  if (applyAll && dryRun) {
    p.log.error("Cannot combine --all and --dry-run.");
    process.exit(2);
  }

  // Passive server checks (informational).
  const passive = await passiveServerChecks();
  const passivePassed = passive.filter((c) => c.ok).length;
  p.note(formatChecks(passive), `server: ${passivePassed}/${passive.length} passing`);

  // Doctor v2 interactive catalog.
  const ctx = buildDoctorContext();
  const effects = buildDoctorEffects();
  const diagnostics = buildDiagnostics(effects);

  if (dryRun) {
    const results: Array<{ diagnostic: Diagnostic; status: { ok: boolean; detail?: string } }> = [];
    for (const d of diagnostics) results.push({ diagnostic: d, status: await d.check(ctx) });
    const lines = dryRunPlan(ctx, results);
    p.note(lines.join("\n"), "dry-run plan");
    p.outro("Dry-run complete. Re-run without --dry-run to apply.");
    return;
  }

  let failed = 0;
  let fixed = 0;
  let skipped = 0;
  let quit = false;

  for (const d of diagnostics) {
    if (quit) {
      skipped++;
      continue;
    }
    const status = await d.check(ctx);
    if (status.ok) {
      p.log.success(`${d.id} ✓${status.detail ? ` (${status.detail})` : ""}`);
      continue;
    }
    failed++;
    p.log.warn(`${d.id} ✗ ${status.detail ?? ""}`.trim());
    p.log.info(`why: ${d.fixPreview}`);

    if (d.manualOnly) {
      p.log.info(`(manual fix only — see "${d.id}" docs)`);
    }

    if (applyAll) {
      const r = await applyFixWithReport(d, ctx, false);
      if (r.ok) fixed++;
      // Re-check only this diagnostic.
      const after = await d.check(ctx);
      if (!after.ok) p.log.warn(`${d.id} still failing after fix.`);
      continue;
    }

    // Interactive prompt loop — allow [?] More info without leaving the check.
    while (true) {
      const action = await askFixAction(d);
      if (action === "fix") {
        const r = await applyFixWithReport(d, ctx, false);
        if (r.ok) {
          const after = await d.check(ctx);
          if (after.ok) {
            fixed++;
          } else {
            p.log.warn(`${d.id} still failing after fix: ${after.detail ?? ""}`);
          }
        }
        break;
      }
      if (action === "skip") {
        skipped++;
        break;
      }
      if (action === "more") {
        p.note(d.moreInfo, `[${d.id}] more info`);
        continue;
      }
      if (action === "quit") {
        quit = true;
        break;
      }
    }
  }

  const summary = `${diagnostics.length} checks · ${failed} failing · ${fixed} fixed · ${skipped} skipped`;
  if (quit) {
    p.outro(`Quit early. ${summary}`);
    process.exit(1);
  }
  if (failed === 0) {
    p.outro("All diagnostics passing. agentmemory is healthy.");
    return;
  }
  if (failed - fixed === 0) {
    p.outro(`All fixes applied. ${summary}`);
    return;
  }
  p.outro(summary);
  process.exit(1);
}

type DemoObservation = {
  toolName: string;
  toolInput: Record<string, string>;
  toolOutput: string;
};

type DemoSession = {
  id: string;
  title: string;
  observations: DemoObservation[];
};

type SearchResult = { query: string; hits: number; topTitle: string };

function buildDemoSessions(): DemoSession[] {
  return [
    {
      id: generateId("demo"),
      title: "Session 1: JWT auth setup",
      observations: [
        {
          toolName: "Write",
          toolInput: { file_path: "src/middleware/auth.ts" },
          toolOutput:
            "Created JWT middleware using jose library. Tokens expire after 30 days. Chose jose over jsonwebtoken for Edge compatibility.",
        },
        {
          toolName: "Write",
          toolInput: { file_path: "test/auth.test.ts" },
          toolOutput:
            "Added token validation tests covering expired, malformed, and valid cases.",
        },
        {
          toolName: "Bash",
          toolInput: { command: "npm test" },
          toolOutput: "All 12 auth tests passing.",
        },
      ],
    },
    {
      id: generateId("demo"),
      title: "Session 2: Database migration debugging",
      observations: [
        {
          toolName: "Read",
          toolInput: { file_path: "prisma/schema.prisma" },
          toolOutput:
            "Found N+1 query issue in user relations. Need to add include on posts query.",
        },
        {
          toolName: "Edit",
          toolInput: { file_path: "src/api/users.ts" },
          toolOutput:
            "Fixed N+1 by adding Prisma include. Query time dropped from 450ms to 28ms.",
        },
      ],
    },
    {
      id: generateId("demo"),
      title: "Session 3: Rate limiting",
      observations: [
        {
          toolName: "Write",
          toolInput: { file_path: "src/middleware/ratelimit.ts" },
          toolOutput:
            "Added rate limiting middleware with 100 req/min default. Uses in-memory store for dev, Redis for prod.",
        },
      ],
    },
  ];
}

async function postJson<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs = 5000,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

async function postJsonStrict<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs = 5000,
): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    const suffix = errBody ? ` — ${errBody.slice(0, 200)}` : "";
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}${suffix}`);
  }
  return (await res.json().catch(() => null)) as T | null;
}

async function seedDemoSession(
  base: string,
  project: string,
  session: DemoSession,
): Promise<number> {
  await postJsonStrict(`${base}/agentmemory/session/start`, {
    sessionId: session.id,
    project,
    cwd: project,
  });

  let stored = 0;
  for (const obs of session.observations) {
    const url = `${base}/agentmemory/observe`;
    const payload = {
      hookType: "post_tool_use",
      sessionId: session.id,
      project,
      cwd: project,
      timestamp: new Date().toISOString(),
      data: {
        tool_name: obs.toolName,
        tool_input: obs.toolInput,
        tool_output: obs.toolOutput,
      },
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        stored++;
      } else {
        const body = await res.text().catch(() => "");
        p.log.warn(
          `observe failed for ${obs.toolName}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ""}`,
        );
      }
    } catch (err) {
      p.log.warn(
        `observe request failed for ${obs.toolName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await postJsonStrict(`${base}/agentmemory/session/end`, { sessionId: session.id });
  return stored;
}

async function runDemoSearch(base: string, query: string): Promise<SearchResult> {
  const data = await postJson<{ results?: Array<{ title?: string }> }>(
    `${base}/agentmemory/smart-search`,
    { query, limit: 5 },
    10000,
  );
  const items = data?.results ?? [];
  return {
    query,
    hits: items.length,
    topTitle: items[0]?.title ?? "(no results)",
  };
}

// Prefer the packaged `.env.example` (next to `dist/cli.mjs`); fall back to
// the repo root when running from a source checkout.
function findEnvExample(): string | null {
  const candidates = [
    join(__dirname, "..", ".env.example"),
    join(__dirname, ".env.example"),
    join(process.cwd(), ".env.example"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function runInit() {
  p.intro("agentmemory init");
  const target = join(homedir(), ".agentmemory", ".env");
  const template = findEnvExample();
  if (!template) {
    p.log.error(
      "Could not locate .env.example in the package. Re-install with: npm i -g @agentmemory/agentmemory",
    );
    process.exit(1);
  }
  const dir = dirname(target);
  const { mkdir, copyFile } = await import("node:fs/promises");
  const { constants: fsConstants } = await import("node:fs");
  try {
    await mkdir(dir, { recursive: true });
    // COPYFILE_EXCL collapses the exists-check + copy into one syscall —
    // an existsSync(target) + copyFile() pair races with a parallel init
    // (or any other process touching ~/.agentmemory/.env between the two
    // calls) and would silently overwrite a config the operator just
    // wrote. EEXIST out of copyFile is the only "already configured"
    // signal we trust.
    await copyFile(template, target, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      p.log.warn(`${target} already exists — leaving it untouched.`);
      p.log.info(
        `Compare against the latest template: diff ${target} ${template}`,
      );
      p.outro("Nothing changed.");
      return;
    }
    p.log.error(
      `Failed to copy template: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  p.log.success(`Wrote ${target}`);
  p.note(
    [
      "All keys are commented out by default. Uncomment the ones you want.",
      "",
      "Common next steps:",
      "  1. Pick an LLM provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / etc.)",
      "  2. Run `npx @agentmemory/agentmemory doctor` to verify the daemon sees them",
      "  3. Run `npx @agentmemory/agentmemory` to start the worker",
    ].join("\n"),
    "Next steps",
  );
  p.outro(`Edit ${target} and you're set.`);
}

async function startServerForDemo(): Promise<void> {
  if (await isAgentmemoryReady()) return;

  // The daemon runs inside this process, so there is nothing to spawn and
  // nothing to reap — runDemo's `process.exit(0)` is the teardown.
  await import("./index.js");
  if (!(await waitForAgentmemoryReady(15000))) {
    p.log.error("agentmemory did not become ready within 15s.");
    process.exit(1);
  }
}

async function runDemo() {
  const port = getRestPort();
  const base = `http://localhost:${port}`;
  p.intro("agentmemory demo");

  const serve = args.includes("--serve");

  if (serve) {
    await startServerForDemo();
  } else if (!(await isAgentmemoryReady())) {
    p.log.error(
      `agentmemory worker not reachable on port ${port} (livez probe failed). Something may be on the port but it isn't serving /agentmemory/*.`,
    );
    p.log.info("Start it with: npx @agentmemory/agentmemory");
    p.log.info("Or run a one-command demo with: npx @agentmemory/agentmemory demo --serve");
    process.exit(1);
  }

  await runDemoBody(base);

  if (serve) {
    process.exit(0);
  }
}

async function runDemoBody(base: string) {
  const demoProject = "/tmp/agentmemory-demo";
  const sessions = buildDemoSessions();

  const sSeed = p.spinner();
  sSeed.start("Seeding 3 demo sessions with realistic observations...");

  let totalObs = 0;
  for (const session of sessions) {
    totalObs += await seedDemoSession(base, demoProject, session);
  }

  sSeed.stop(`Seeded ${totalObs} observations across ${sessions.length} sessions`);

  const queries = [
    "jwt auth middleware",
    "database performance optimization",
    "rate limiting",
  ];

  const sQuery = p.spinner();
  sQuery.start(`Running ${queries.length} smart-search queries...`);

  const results: SearchResult[] = [];
  for (const query of queries) {
    results.push(await runDemoSearch(base, query));
  }

  sQuery.stop("Search complete");

  // Only claim the semantic-recall win when the search actually hit.
  // Without an embedding key this query returns 0 hits, and asserting
  // success over a visibly failed search reads as a lie.
  const semanticHits =
    results.find((r) => r.query === "database performance optimization")
      ?.hits ?? 0;
  const lines = [
    `Project:       ${demoProject}`,
    `Sessions:      ${sessions.length} seeded (${totalObs} observations)`,
    "",
    c.label("Search results:"),
    ...results.flatMap((r) => [
      `  ${c.label(`"${r.query}"`)}`,
      `    ${c.dim("→")} ${c.ok(`${r.hits} hit(s)`)}, top: ${r.topTitle.slice(0, 60)}`,
    ]),
    "",
    ...(semanticHits > 0
      ? [
          c.accent(`Notice: searching "database performance optimization"`),
          c.accent(`found the N+1 query fix — keyword matching can't do that.`),
        ]
      : [
          c.dim(`Note: "database performance optimization" found nothing —`),
          c.dim(`semantic recall needs an embedding provider key (e.g.`),
          c.dim(`OPENAI_API_KEY or GEMINI_API_KEY in ~/.agentmemory/.env).`),
        ]),
    "",
    `Viewer:        ${c.url(getViewerUrl())}`,
    `Clean up with: ${c.dim(`curl -X DELETE "${base}/agentmemory/sessions?project=${demoProject}"`)}`,
  ];

  p.note(lines.join("\n"), "demo complete");
  p.log.success("agentmemory is working. Point your agent at it and get back to coding.");
}

function runCommand(
  command: string,
  commandArgs: string[],
  options: { cwd?: string; label: string; optional?: boolean } = { label: "command" },
): boolean {
  const spinner = p.spinner();
  spinner.start(options.label);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || process.cwd(),
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (result.status === 0) {
    spinner.stop(`${options.label} ${pc.green("✓")}`);
    return true;
  }

  const stderr = (result.stderr || "").toString().trim();
  const stdout = (result.stdout || "").toString().trim();
  const msg = stderr || stdout || "unknown error";

  if (options.optional) {
    spinner.stop(`${options.label} (skipped)`);
    p.log.warn(msg.slice(0, 300));
    return false;
  }

  spinner.stop(`${options.label} ${pc.red("✗")}`);
  p.log.error(msg.slice(0, 300));
  return false;
}

async function runUpgrade() {
  p.intro("agentmemory upgrade");

  const cwd = process.cwd();
  const hasPackageJson = existsSync(join(cwd, "package.json"));
  const hasPnpmLock = existsSync(join(cwd, "pnpm-lock.yaml"));

  const pnpmBin = whichBinary("pnpm");
  const npmBin = whichBinary("npm");

  p.log.info(`Working directory: ${cwd}`);
  const requireSuccess = (ok: boolean, label: string): void => {
    if (!ok) {
      p.log.error(`Upgrade aborted: ${label} failed.`);
      process.exit(1);
    }
  };

  if (hasPackageJson) {
    const usePnpm = !!pnpmBin && hasPnpmLock;
    if (usePnpm && pnpmBin) {
      const installOk = runCommand(pnpmBin, ["install"], {
        label: "Refreshing dependencies (pnpm install)",
      });
      requireSuccess(installOk, "pnpm install");
    } else if (npmBin) {
      const installOk = runCommand(npmBin, ["install"], {
        label: "Refreshing dependencies (npm install)",
      });
      requireSuccess(installOk, "npm install");
    } else {
      p.log.warn("No package manager found (pnpm/npm). Skipping JS dependency upgrade.");
    }
  } else {
    p.log.warn("No package.json in current directory. Skipping JS dependency upgrade.");
  }

  p.note(
    [
      "Upgrade flow completed.",
      "",
      "Recommended next steps:",
      "  1) agentmemory status",
      "  2) npm/pnpm test",
      "  3) restart agentmemory process",
    ].join("\n"),
    "agentmemory upgrade",
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function signalAndWait(
  pid: number,
  initialSignal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  try {
    process.kill(pid, initialSignal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") {
      p.log.warn(`No permission to signal pid ${pid}. Try: kill ${pid}`);
      return false;
    }
    vlog(`${initialSignal} ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!pidAlive(pid)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return true;
    vlog(`SIGKILL ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  await new Promise((r) => setTimeout(r, 200));
  return !pidAlive(pid);
}

// Shared daemon reap: SIGTERM with a grace window sized for the shutdown
// flush (audit rows and vector writes commit on the way out).
async function stopWorkerPid(pid: number, graceMs: number): Promise<boolean> {
  const s = p.spinner();
  s.start(`Stopping agentmemory (pid ${pid})... [flushing state]`);
  const ok = await signalAndWait(pid, "SIGTERM", graceMs);
  s.stop(ok ? `Stopped pid ${pid}` : `Failed to stop pid ${pid}`);
  return ok;
}

function pidCommand(pid: number): string {
  if (IS_WINDOWS) return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function findDaemonPidsByPort(port: number): number[] {
  if (IS_WINDOWS) return [];
  const lsof = whichBinary("lsof");
  if (!lsof) return [];
  // -sTCP:LISTEN restricts to listening server sockets only. Without
  // this, lsof also returns client-side PIDs (any process with an
  // active TCP connection to :port), which includes the agentmemory
  // CLI itself thanks to the keep-alive fetch in isDaemonRunning().
  // signalAndWait would then SIGKILL its own parent — exit code 137.
  const selfPid = process.pid;
  try {
    const out = execFileSync(lsof, ["-i", `:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== selfPid);
  } catch (err) {
    vlog(`lsof :${port}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function runStop(): Promise<void> {
  p.intro("agentmemory stop");
  const port = getRestPort();
  const running = await isDaemonRunning();
  const force = args.includes("--force");

  const portPids = findDaemonPidsByPort(port);
  // Read the pid up front so the not-responding branch can still reap a
  // daemon whose REST listener died but whose process is still around.
  const workerPid = readWorkerPidfile();

  if (!running) {
    if (portPids.length === 0 && workerPid === null) {
      clearWorkerPidfile();
      p.outro("Nothing to stop.");
      return;
    }
    if (workerPid !== null && portPids.length === 0) {
      const s = p.spinner();
      s.start(`Stopping orphaned agentmemory (pid ${workerPid})...`);
      const ok = await signalAndWait(workerPid, "SIGTERM", 3000);
      s.stop(ok ? `Stopped pid ${workerPid}` : `Failed to stop pid ${workerPid}`);
      clearWorkerPidfile();
      if (!ok) {
        p.log.error(`Pid ${workerPid} survived SIGKILL. Investigate with \`ps\`.`);
        process.exit(1);
      }
      p.outro("Stopped orphaned daemon. Memories persisted to disk.");
      return;
    }
    const survivors = new Set<number>(portPids);
    if (workerPid) survivors.add(workerPid);
    p.log.warn(
      `Not responding on :${port}, but ${survivors.size} process(es) still hold the port or pidfile: ${[...survivors].join(", ")}`,
    );
    p.log.info(
      `Preserving ~/.agentmemory/worker.pid. Investigate before manual cleanup:\n  ps -p ${[...survivors].join(",")} -o pid,ppid,comm,etime\n  ${IS_WINDOWS ? "netstat -ano | findstr :" + port : "lsof -i :" + port}`,
    );
    process.exit(1);
  }

  if (workerPid === null && portPids.length === 0) {
    p.log.error(
      `Could not locate the agentmemory process. Try:\n  ${IS_WINDOWS ? "netstat -ano | findstr :" + port : "lsof -i :" + port + " -t | xargs kill -9"}`,
    );
    process.exit(1);
  }

  let allStopped = true;
  if (workerPid !== null) {
    if (!(await stopWorkerPid(workerPid, 5000))) allStopped = false;
  }

  // The pidfile is the only positive identity we have: the daemon is a
  // plain `node` process, so anything else on :port — a Docker forward, an
  // ssh tunnel, a stray dev server — is reported rather than signaled.
  const unowned: Array<{ pid: number; comm: string }> = [];
  for (const pid of portPids) {
    if (pid === workerPid) continue;
    if (!force) {
      unowned.push({ pid, comm: pidCommand(pid) });
      continue;
    }
    if (!(await stopWorkerPid(pid, 5000))) allStopped = false;
  }

  clearWorkerPidfile();
  if (unowned.length > 0) {
    const list = unowned.map((u) => `  pid ${u.pid}  ${u.comm}`).join("\n");
    p.log.error(
      `Refused to signal process(es) holding :${port} that the agentmemory pidfile does not claim:\n${list}\n\nRe-run with --force to signal them anyway.`,
    );
    process.exit(1);
  }
  if (!allStopped) {
    p.log.error("One or more processes survived SIGKILL. Investigate with `ps`.");
    process.exit(1);
  }
  p.outro("Stopped. Memories persisted to disk; restart anytime with: npx @agentmemory/agentmemory");
}

async function runMcp(): Promise<void> {
  await import("./mcp/standalone.js");
}

async function runConnectCmd(): Promise<void> {
  const { runConnect } = await import("./cli/connect/index.js");
  await runConnect(args.slice(1));
}

async function runImportJsonl(): Promise<void> {
  // Long-form flags that take a value. Their value tokens must be
  // consumed alongside the flag so they don't leak into positional
  // args (e.g. `--port 3112 import-jsonl` would otherwise turn
  // 3112 into pathArg).
  const VALUE_FLAGS = new Set(["--port", "--tools", "--data-dir"]);
  let maxFiles: number | undefined;
  const tail = args.slice(1);
  const positional: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a === "--max-files") {
      const raw = tail[i + 1];
      const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
      if (Number.isInteger(parsed) && parsed > 0) {
        maxFiles = parsed;
      } else if (raw !== undefined) {
        p.log.warn(`Ignoring --max-files ${raw}: expected a positive integer.`);
      }
      i++;
      continue;
    }
    if (a.startsWith("--max-files=")) {
      const raw = a.slice("--max-files=".length);
      const parsed = parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        maxFiles = parsed;
      } else {
        p.log.warn(`Ignoring --max-files=${raw}: expected a positive integer.`);
      }
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const pathArg = positional[0];

  const port = getRestPort();
  const base = `http://localhost:${port}`;

  let probeOk = false;
  let probeDetail = "";
  try {
    const probe = await fetch(`${base}/agentmemory/livez`, {
      signal: AbortSignal.timeout(2000),
    });
    probeOk = probe.ok;
    if (!probeOk) {
      const probeBody = await probe.text().catch(() => "");
      probeDetail = `reachable but unhealthy (HTTP ${probe.status}${probeBody ? `: ${probeBody.slice(0, 200)}` : ""})`;
    }
  } catch (err) {
    probeOk = false;
    const msg = err instanceof Error ? err.message : String(err);
    probeDetail = `unreachable (${msg})`;
  }
  if (!probeOk) {
    p.log.error(
      `agentmemory livez probe failed on port ${port}: ${probeDetail}. Start it with \`npx @agentmemory/agentmemory\` in another terminal, then re-run this command.`,
    );
    process.exit(1);
  }

  const body: Record<string, unknown> = {};
  if (pathArg) body["path"] = pathArg;
  if (maxFiles !== undefined) body["maxFiles"] = maxFiles;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = process.env["AGENTMEMORY_SECRET"];
  if (secret) headers["authorization"] = `Bearer ${secret}`;

  p.log.info(`Importing JSONL from ${pathArg || "~/.claude/projects"}…`);
  const spinner = p.spinner();
  spinner.start("scanning files");

  try {
    const res = await fetch(`${base}/agentmemory/replay/import-jsonl`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json: {
      success?: boolean;
      error?: string;
      imported?: number;
      sessionIds?: string[];
      observations?: number;
      discovered?: number;
      truncated?: boolean;
      traversalCapped?: boolean;
      maxFiles?: number;
      maxFilesUpperBound?: number;
    } = {};
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        spinner.stop("failed");
        p.log.error(
          `server returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
        );
        process.exit(1);
      }
    }
    if (!res.ok || json.success !== true) {
      spinner.stop("failed");
      const detail =
        json.error ||
        (text.length === 0
          ? "empty response body"
          : json.success === undefined
            ? `HTTP ${res.status} (response missing success field)`
            : `HTTP ${res.status}`);
      if (res.status === 401) {
        p.log.error(
          `${detail}. Set AGENTMEMORY_SECRET to match the server's secret and re-run.`,
        );
      } else if (res.status === 404) {
        p.log.error(
          `${detail}. The running agentmemory server does not expose /agentmemory/replay/import-jsonl — upgrade to v0.8.13 or later.`,
        );
      } else {
        p.log.error(detail);
      }
      process.exit(1);
    }
    spinner.stop(
      `imported ${json.imported ?? 0} file(s), ${json.observations ?? 0} observation(s) across ${json.sessionIds?.length || 0} session(s)`,
    );
    if (json.truncated) {
      const cap = json.maxFiles ?? 200;
      const upper = json.maxFilesUpperBound ?? 1000;
      const discovered = json.discovered ?? 0;
      const skipped = discovered - (json.imported ?? 0);
      const discoveredLabel = json.traversalCapped
        ? `${discovered}+ (traversal halted at safety cap)`
        : String(discovered);
      const baseMsg = `Hit the ${cap}-file scan cap; ${skipped} of ${discoveredLabel} discovered file(s) were skipped.`;
      // If we already saw more than the server's hard cap (or the
      // walker stopped early), bumping --max-files won't help on its
      // own — recommend batching by subdirectory.
      if (discovered > upper || json.traversalCapped) {
        p.log.warn(
          `${baseMsg} Tree exceeds the server's --max-files limit of ${upper}; ` +
            `batch by subdirectory (run import-jsonl once per project under ~/.claude/projects).`,
        );
      } else {
        const suggested = Math.min(
          Math.max((discovered || cap) + 100, cap * 2),
          upper,
        );
        p.log.warn(
          `${baseMsg} Re-run with --max-files=${suggested} (max ${upper}) or batch by subdirectory.`,
        );
      }
    }
    if (json.sessionIds && json.sessionIds.length > 0) {
      p.log.info(`View at ${getViewerUrl()} → Replay tab`);
    }
  } catch (err) {
    spinner.stop("failed");
    if (err instanceof Error && err.name === "TimeoutError") {
      p.log.error("import timed out after 2 minutes");
    } else {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// `agentmemory remove` — clean uninstall.
//
// Planning logic lives in src/cli/remove-plan.ts so it's testable without
// touching $HOME. This function loads the manifest, builds the plan,
// double-confirms, then executes step by step.

function loadConnectManifest(home: string): ConnectManifest | null {
  const path = join(home, ".agentmemory", "backups", "connect-manifest.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ConnectManifest>;
    if (Array.isArray(parsed?.installed)) {
      return { installed: parsed.installed };
    }
    return null;
  } catch {
    return null;
  }
}

function safeDelete(path: string): { ok: boolean; message: string } {
  try {
    if (!existsSync(path)) return { ok: true, message: `not present (${path})` };
    const st = statSync(path);
    if (st.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
    return { ok: true, message: `deleted ${path}` };
  } catch (err) {
    return {
      ok: false,
      message: `failed ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runRemove(): Promise<void> {
  p.intro("agentmemory remove");
  const force = args.includes("--force");
  const keepData = args.includes("--keep-data");

  const home = homedir();
  const connectManifest = loadConnectManifest(home);

  const options: RemoveOptions = { force, keepData };
  const plan = buildRemovePlan({ home, connectManifest }, options);

  const applicable = plan.filter((it) => it.applicable);
  if (applicable.length === 0) {
    p.outro("Nothing to remove. agentmemory is already gone.");
    return;
  }

  p.note(formatPlan(plan), "destruction plan");

  if (!force) {
    const proceed = await p.confirm({
      message: "Proceed with these deletions?",
      initialValue: false,
    });
    if (p.isCancel(proceed) || proceed !== true) {
      p.cancel("Cancelled. Nothing was deleted.");
      return;
    }
    const sure = await p.confirm({
      message: "This is irreversible. Continue?",
      initialValue: false,
    });
    if (p.isCancel(sure) || sure !== true) {
      p.cancel("Cancelled. Nothing was deleted.");
      return;
    }
  }

  for (const item of plan) {
    if (!item.applicable) continue;

    // alwaysAsk items get a per-item confirmation even with --force.
    if (item.alwaysAsk) {
      const ok = await p.confirm({
        message: `${item.description} — really delete${item.path ? ` ${item.path}` : ""}?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || ok !== true) {
        p.log.info(`skipped: ${item.id}`);
        continue;
      }
    }

    if (item.id === "stop-daemon") {
      try {
        const port = getRestPort();
        const portPids = findDaemonPidsByPort(port);
        const pidfilePid = readWorkerPidfile();
        const cands = new Set<number>();
        if (pidfilePid) cands.add(pidfilePid);
        for (const pid of portPids) cands.add(pid);
        for (const pid of cands) await signalAndWait(pid, "SIGTERM", 3000);
        clearWorkerPidfile();
        p.log.success(
          cands.size > 0
            ? `stopped agentmemory (${cands.size} pid${cands.size === 1 ? "" : "s"})`
            : "nothing running",
        );
      } catch (err) {
        p.log.warn(
          `daemon stop best-effort: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
    }

    if (!item.path) continue;
    const r = safeDelete(item.path);
    if (r.ok) p.log.success(r.message);
    else p.log.error(r.message);
  }

  p.outro(
    "Done. agentmemory cleanly removed. The npm package itself: npm uninstall -g @agentmemory/agentmemory",
  );
}

const commands: Record<string, () => Promise<void>> = {
  init: runInit,
  connect: runConnectCmd,
  status: runStatus,
  doctor: runDoctor,
  demo: runDemo,
  upgrade: runUpgrade,
  stop: runStop,
  remove: runRemove,
  mcp: runMcp,
  "import-jsonl": runImportJsonl,
};

const first = args[0] ?? "";
async function unknownCommand(): Promise<void> {
  p.log.error(
    `Unknown command: ${first}. Supported: ${Object.keys(commands).join(", ")}. Run \`agentmemory\` with no arguments to start the memory server, or \`agentmemory --help\` for usage.`,
  );
  process.exit(1);
}
// Only a bare invocation or flag-style args boot the server; an unrecognized
// word is an error. Previously any typo (or a guessed subcommand like
// `agentmemory consolidate`) fell through to the full server boot and could
// break a running daemon.
const handler = commands[first] ?? (first && !first.startsWith("-") ? unknownCommand : main);
handler().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
