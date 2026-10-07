import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HINDSIGHT_PLUGIN,
  bankId,
  injectionText,
  recallItems,
  recallQuery,
  stopRetains,
  type RecallResult,
} from "./replay-hindsight.js";
import type { Probe, ProbeKind } from "./replay-score.js";
import type { ReplaySession } from "./replay-transcript.js";
import { isListening } from "./sandbox.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const HINDSIGHT_IMAGE = "ghcr.io/vectorize-io/hindsight:latest";
const CONTAINER = "hindsight-eval";
const DATA_DIR = resolve(REPO_ROOT, "tmp/eval-sandbox/hindsight");
const PG_DIR = "/home/hindsight/.pg0";
// agentmemory's local embedder is Xenova/bge-small-en-v1.5; this is the same
// model, and it and the reranker are Hindsight's own defaults.
const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
const RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2";
const SEARCH_LIMIT = 5;
const BOOT_TIMEOUT_MS = 10 * 60_000;
const DRAIN_POLL_MS = 1000;
const DRAIN_STALL_MS = 15 * 60_000;
const PAGE = 500;

function containerEngine(): string {
  for (const engine of ["docker", "podman"]) {
    if (spawnSync(engine, ["--version"], { stdio: "ignore" }).status === 0) return engine;
  }
  throw new Error("--backend hindsight needs docker or podman");
}

// The run's OpenAI-compatible provider, renamed for Hindsight. The key goes
// to the container through the environment, never on the command line.
function llmEnv(): Record<string, string> {
  const url = new URL(process.env.OPENAI_BASE_URL ?? "https://api.openai.com");
  if (url.pathname.replace(/\/+$/, "") === "") url.pathname = "/v1";
  const env: Record<string, string> = {
    HINDSIGHT_API_LLM_PROVIDER: "openai",
    HINDSIGHT_API_LLM_API_KEY: process.env.OPENAI_API_KEY ?? "",
    HINDSIGHT_API_LLM_BASE_URL: url.toString().replace(/\/+$/, ""),
    HINDSIGHT_API_LLM_MODEL: process.env.OPENAI_MODEL ?? "",
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: "local",
    HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: EMBEDDING_MODEL,
    HINDSIGHT_API_RERANKER_PROVIDER: "local",
    // Traces are how calls per retain are counted; their prompts are cut
    // short so they barely add to the store's size.
    HINDSIGHT_API_LLM_TRACE_ENABLED: "true",
    HINDSIGHT_API_LLM_TRACE_RETENTION_DAYS: "-1",
    HINDSIGHT_API_LLM_TRACE_MAX_CHARS: "200",
  };
  if (process.env.OPENAI_REASONING_EFFORT) env.HINDSIGHT_API_LLM_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT;
  if (process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY) env.HINDSIGHT_API_LLM_MAX_CONCURRENT = process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY;
  if (process.env.AGENTMEMORY_LLM_TIMEOUT_MS) {
    env.HINDSIGHT_API_LLM_TIMEOUT = String(Math.ceil(Number(process.env.AGENTMEMORY_LLM_TIMEOUT_MS) / 1000));
  }
  return env;
}

async function call<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ body: T; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  return { body: JSON.parse(text) as T, ms };
}

const bankPath = (project: string) => `/v1/default/banks/${encodeURIComponent(bankId(project))}`;

interface LlmRequest {
  operation: string | null;
  status: string;
  duration_ms: number | null;
}

// Starts the throwaway `hindsight-eval` container on a localhost port, with
// its embedded Postgres under the repo's tmp/, and drives it the way the
// Claude Code integration would. stop() removes the container and its data.
export async function startHindsight(opts: { port: number }) {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
    throw new Error("--backend hindsight needs the OpenAI-compatible provider in the shell: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL");
  }
  if (await isListening(opts.port)) throw new Error(`port ${opts.port} already in use; pick another --hindsight-port`);
  const engine = containerEngine();
  const run = (args: string[], env?: Record<string, string>) =>
    execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
  spawnSync(engine, ["rm", "-f", CONTAINER], { stdio: "ignore" });
  const wipe = () => {
    // Rootless podman writes the volume as a sub-uid the host user cannot delete.
    if (engine === "podman") spawnSync("podman", ["unshare", "rm", "-rf", DATA_DIR], { stdio: "ignore" });
    rmSync(DATA_DIR, { recursive: true, force: true });
  };
  wipe();
  mkdirSync(DATA_DIR, { recursive: true });
  chmodSync(DATA_DIR, 0o777);
  const env = llmEnv();
  run(
    [
      "run", "-d", "--name", CONTAINER,
      "-p", `127.0.0.1:${opts.port}:8888`,
      "-v", `${DATA_DIR}:${PG_DIR}`,
      ...Object.keys(env).flatMap((k) => ["-e", k]),
      HINDSIGHT_IMAGE,
    ],
    env,
  );
  const stop = async () => {
    spawnSync(engine, ["rm", "-f", CONTAINER], { stdio: "ignore" });
    wipe();
  };

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const up = await call(baseUrl, "GET", "/health").then(() => true, () => false);
    if (up) break;
    if (Date.now() > deadline || run(["inspect", "-f", "{{.State.Running}}", CONTAINER]) !== "true") {
      const logs = spawnSync(engine, ["logs", "--tail", "20", CONTAINER], { encoding: "utf8" });
      await stop();
      throw new Error(`hindsight did not come up on ${baseUrl}:\n${logs.stdout}${logs.stderr}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const version = (await call<{ api_version?: string; version?: string }>(baseUrl, "GET", "/version")).body;
  const imageId = run(["inspect", "-f", "{{.Image}}", CONTAINER]);

  const missions = new Set<string>();
  const owners = new Map<string, string>();
  const cwds = new Map<string, Set<string>>();
  let retainsSent = 0;
  let drainMsTotal = 0;

  // ensure_bank_mission: once per bank, before its first recall or retain.
  const ensureBank = async (project: string) => {
    if (missions.has(project)) return;
    await call(baseUrl, "PATCH", `${bankPath(project)}/config`, {
      updates: { reflect_mission: HINDSIGHT_PLUGIN.bankMission, retain_mission: HINDSIGHT_PLUGIN.retainMission },
    });
    missions.add(project);
  };

  const recall = (project: string, query: string, types?: readonly string[]) =>
    call<{ results?: RecallResult[] }>(baseUrl, "POST", `${bankPath(project)}/memories/recall`, {
      query,
      max_tokens: HINDSIGHT_PLUGIN.recall.maxTokens,
      budget: HINDSIGHT_PLUGIN.recall.budget,
      ...(types && { types }),
    });

  // Retain is async and schedules consolidation (which writes the
  // observations recall injects); the bank is idle once neither is queued.
  const drained = async (project: string) => {
    let idleChecks = 0;
    let pending = Infinity;
    let progressAt = Date.now();
    for (;;) {
      const counts = await Promise.all(
        ["pending", "processing"].map(async (status) =>
          (await call<{ total: number }>(baseUrl, "GET", `${bankPath(project)}/operations?status=${status}&limit=1`)).body.total,
        ),
      );
      const now = counts[0] + counts[1];
      if (now === 0 && ++idleChecks >= 2) return;
      if (now > 0) idleChecks = 0;
      if (now < pending) progressAt = Date.now();
      pending = now;
      if (Date.now() - progressAt > DRAIN_STALL_MS) {
        console.warn(`  ${now} Hindsight operations still queued after ${DRAIN_STALL_MS / 60_000} min without progress`);
        return;
      }
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
  };

  const paged = async <T>(path: string, key: "items"): Promise<T[]> => {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const sep = path.includes("?") ? "&" : "?";
      const { body } = await call<Record<typeof key, T[]> & { total: number }>(baseUrl, "GET", `${path}${sep}limit=${PAGE}&offset=${offset}`);
      out.push(...body[key]);
      if (body[key].length < PAGE) return out;
    }
  };

  const probe = async (session: ReplaySession, maxPrompts: number): Promise<Probe[]> => {
    const probes: Probe[] = [];
    const attempt = async (kind: ProbeKind, turn: number, fn: () => Promise<Omit<Probe, "kind" | "turn">>) => {
      try {
        probes.push({ kind, turn, ...(await fn()) });
      } catch (err) {
        console.warn(`  ${kind} probe failed at turn ${turn}: ${err instanceof Error ? err.message : String(err)}`);
        probes.push({ kind, turn, latencyMs: 0, chars: 0, items: [], failed: true });
      }
    };
    const project = session.project;
    const projectCwds = [...(cwds.get(project) ?? []), session.cwd];
    await ensureBank(project);
    for (const turn of session.userTurns.slice(0, maxPrompts)) {
      const query = recallQuery(turn.text);
      if (query) {
        await attempt("prompt-context", turn.turn, async () => {
          const { body, ms } = await recall(project, query, HINDSIGHT_PLUGIN.recall.types);
          const results = body.results ?? [];
          return { latencyMs: ms, chars: injectionText(results, new Date()).length, items: recallItems(results, owners, projectCwds) };
        });
      }
      await attempt("search", turn.turn, async () => {
        const { body, ms } = await recall(project, turn.text.slice(0, HINDSIGHT_PLUGIN.recall.maxQueryChars));
        const items = recallItems((body.results ?? []).slice(0, SEARCH_LIMIT), owners, projectCwds);
        return { latencyMs: ms, chars: items.reduce((n, i) => n + i.text.length, 0), items };
      });
    }
    return probes;
  };

  const ingest = async (session: ReplaySession): Promise<string> => {
    const project = session.project;
    await ensureBank(project);
    const retains = stopRetains(readFileSync(session.sourcePath!, "utf8"), session.id);
    for (const r of retains) {
      await call(baseUrl, "POST", `${bankPath(project)}/memories`, {
        items: [
          {
            content: r.content,
            document_id: r.documentId,
            context: HINDSIGHT_PLUGIN.retainContext,
            metadata: { retained_at: new Date().toISOString(), message_count: String(r.messageCount), session_id: session.id },
            tags: [session.id],
          },
        ],
        async: true,
      });
    }
    retainsSent += retains.length;
    const t0 = Date.now();
    await drained(project);
    const drainMs = Date.now() - t0;
    drainMsTotal += drainMs;
    for (const unit of await paged<{ id: string }>(`${bankPath(project)}/memories/list`, "items")) owners.set(unit.id, project);
    cwds.set(project, new Set([...(cwds.get(project) ?? []), session.cwd]));
    return ` retains=${retains.length} drain=${Math.round(drainMs / 1000)}s`;
  };

  const storeBytes = async (): Promise<number> => Number(run(["exec", CONTAINER, "du", "-sb", PG_DIR]).split(/\s+/)[0]);

  const metrics = async () => {
    const requests = (
      await Promise.all([...missions].map((p) => paged<LlmRequest>(`${bankPath(p)}/llm-requests`, "items")))
    ).flat();
    const byOperation: Record<string, { calls: number; failures: number; avgLatencyMs: number | null }> = {};
    for (const op of new Set(requests.map((r) => r.operation ?? "unknown"))) {
      const of = requests.filter((r) => (r.operation ?? "unknown") === op);
      const timed = of.flatMap((r) => (r.duration_ms === null ? [] : [r.duration_ms]));
      byOperation[op] = {
        calls: of.length,
        failures: of.filter((r) => r.status !== "success").length,
        avgLatencyMs: timed.length === 0 ? null : Math.round(timed.reduce((a, b) => a + b, 0) / timed.length),
      };
    }
    return {
      retainsSent,
      llmCalls: requests.length,
      llmCallsPerRetain: retainsSent === 0 ? null : requests.length / retainsSent,
      byOperation,
      drainMinutes: drainMsTotal / 60_000,
    };
  };

  const providers = () => {
    const base = process.env.OPENAI_BASE_URL;
    return {
      backend: "hindsight",
      image: HINDSIGHT_IMAGE,
      imageId,
      version: version.api_version ?? version.version ?? null,
      integration: `hindsight-integrations/claude-code ${HINDSIGHT_PLUGIN.version} (dynamicBankId, agent+project)`,
      embeddings: "local",
      embeddingModel: EMBEDDING_MODEL,
      rerank: RERANKER_MODEL,
      llm: {
        provider: "openai-compatible",
        model: process.env.OPENAI_MODEL,
        baseUrlHost: base ? new URL(base).host : "api.openai.com",
        reasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? null,
        maxConcurrency: process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY ?? null,
      },
    };
  };

  return { probe, ingest, storeBytes, metrics, providers, stop };
}
