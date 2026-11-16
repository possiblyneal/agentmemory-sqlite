import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hydratedKeys } from "../../src/hooks/_env.js";
import { KV } from "../../src/state/schema.js";

// Above any epoch millisecond count, so the stop never finds a consolidation due.
const NEVER_DUE_COOLDOWN_MS = "9007199254740991";

export type EmbeddingMode = "local" | "none";

export interface Sandbox {
  baseUrl: string;
  sqlitePath: string;
  logPath: string;
  // Resolves once the boot vector fill has embedded every row the store
  // arrived without, so a seeded store is searched with all its vectors.
  vectorsFilled(): Promise<void>;
  stop(): Promise<void>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOT_TIMEOUT_MS = 30_000;
const SEEDED_BOOT_TIMEOUT_MS = 5 * 60_000;
const VECTOR_FILL_TIMEOUT_MS = 45 * 60_000;
const STOP_GRACE_MS = 10_000;

// Mirrors `--instance N` in src/cli.ts: REST anchors the block, streams and
// the viewer sit at REST+1 and REST+2.
function instancePorts(instance: number): number[] {
  const rest = 3111 + instance * 100;
  return [rest, rest + 1, rest + 2];
}

export function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: "localhost" });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

// readyz, not livez: livez answers as soon as the ports bind, while every
// other route still answers 503 until a non-empty store has hydrated.
// A seeded store whose vectors are re-embedded holds the daemon's event loop
// for a minute or more right after readyz opens, so each poll may wait out the
// whole boot deadline; a refused connection still fails at once.
async function isUp(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/agentmemory/readyz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The daemon reads ~/.agentmemory/.env and inherits provider keys from the
// shell, so the sandbox gets its own HOME under the repo's tmp/ and an env
// built from scratch: no LLM provider unless the run asks for one, and only
// the embedding provider the run asks for. A shell that sets
// EMBEDDING_PROVIDER and OPENAI_EMBEDDING_* picks a remote embedder for every
// run that uses embeddings at all; the endpoint is never written in the repo.
// AGENTMEMORY_LOCAL_EMBEDDING_* (model, dimensions) is forwarded the same way,
// so the shell picks which local model a run embeds with.
// A run that opts into an LLM gets the OpenAI-compatible provider settings
// from the shell, and nothing else that would pick a different provider. Its
// LLM deadline is fixed at EVAL_LLM_TIMEOUT_MS whatever the shell says: on a
// shared broker a 5-minute deadline failed calls a live daemon would retry
// later, and a failed summarize contaminates the arm.
export const EVAL_LLM_TIMEOUT_MS = 10 * 60_000;
// Greedy decoding with a fixed seed, so two arms differ by their code and not
// by sampling: the broker's own default is temperature 1.
export const EVAL_LLM_SAMPLING = JSON.stringify({ temperature: 0, seed: 42 });
const LLM_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_REASONING_EFFORT",
  "AGENTMEMORY_LLM_MAX_CONCURRENCY",
  "AGENTMEMORY_AUTO_COMPRESS",
];

// What the launching shell set. A key that hydrateEnvFromFile copied in from
// the Operator's ~/.agentmemory/.env is not the shell's, and forwarding it
// would make a run depend on the live config.
export function shellEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !hydratedKeys.has(key)));
}

// A runner's default for a setting the shell left unset. A copy hydrated from
// the .env does not count as set: the runner's value replaces it and is forwarded.
export function defaultUnlessShellSet(key: string, value: string): void {
  if (shellEnv()[key] !== undefined) return;
  process.env[key] = value;
  hydratedKeys.delete(key);
}

// The model cache sits beside the instance dirs, not in the per-run HOME
// that startSandbox wipes, so a restart does not download the model again.
export function sandboxEnv(
  home: string,
  sqlitePath: string,
  modelCacheDir: string,
  embeddings: EmbeddingMode,
  llm: boolean,
  compress = true,
  derived = false,
) {
  const shell = shellEnv();
  const env: Record<string, string> = {
    PATH: shell.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    AGENTMEMORY_SQLITE_PATH: sqlitePath,
    EVICTION_ENABLED: "false",
    AGENTMEMORY_MODEL_CACHE_DIR: modelCacheDir,
  };
  for (const [key, value] of Object.entries(shell)) {
    if (key.startsWith("HF_") && value !== undefined) env[key] = value;
  }
  if (embeddings === "local") env.EMBEDDING_PROVIDER = "local";
  if (embeddings !== "none") {
    for (const [key, value] of Object.entries(shell)) {
      const forwarded =
        key === "EMBEDDING_PROVIDER" ||
        key.startsWith("OPENAI_EMBEDDING_") ||
        key.startsWith("AGENTMEMORY_LOCAL_EMBEDDING_");
      if (forwarded && value !== undefined) env[key] = value;
    }
  }
  if (shell.RERANK_ENABLED) env.RERANK_ENABLED = shell.RERANK_ENABLED;
  if (shell.AGENTMEMORY_MEMORY_CHUNKING) {
    env.AGENTMEMORY_MEMORY_CHUNKING = shell.AGENTMEMORY_MEMORY_CHUNKING;
  }
  for (const key of [
    "GRAPH_EXTRACTION_ENABLED",
    "GRAPH_EXTRACTION_BATCH_SIZE",
    "AGENTMEMORY_GRAPH_WEIGHT",
    "AGENTMEMORY_GRAPH_LEG",
  ]) {
    const value = shell[key];
    if (value) env[key] = value;
  }
  if (shell.AGENTMEMORY_INJECT_CONTEXT) {
    env.AGENTMEMORY_INJECT_CONTEXT = shell.AGENTMEMORY_INJECT_CONTEXT;
  }
  if (shell.AGENTMEMORY_PROMPT_RERANK_URL) {
    for (const key of [
      "AGENTMEMORY_PROMPT_RERANK",
      "AGENTMEMORY_PROMPT_RERANK_URL",
      "AGENTMEMORY_PROMPT_RERANK_MIN",
      "AGENTMEMORY_PROMPT_LESSON_MIN",
      "AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS",
    ]) {
      const value = shell[key];
      if (value) env[key] = value;
    }
  } else {
    env.AGENTMEMORY_PROMPT_RERANK = "off";
  }
  if (llm) {
    // process.env, not the shell's alone: a runner that loads the daemon's
    // provider from ~/.agentmemory/.env (the decision judge) shares it.
    for (const key of LLM_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.OPENAI_TIMEOUT_MS = String(EVAL_LLM_TIMEOUT_MS);
    env.AGENTMEMORY_LLM_TIMEOUT_MS = String(EVAL_LLM_TIMEOUT_MS);
    env.OPENAI_EXTRA_BODY = EVAL_LLM_SAMPLING;
    if (!compress) env.AGENTMEMORY_AUTO_COMPRESS = "false";
  }
  if (derived) {
    env.AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS = NEVER_DUE_COOLDOWN_MS;
  }
  return env;
}

export async function startSandbox(opts: {
  instance: number;
  embeddings: EmbeddingMode;
  llm?: boolean;
  // false keeps Compression synthetic while the LLM provider stays configured.
  compress?: boolean;
  // The replay's --derived mode: the stop's own consolidation never due.
  derived?: boolean;
  // A store file the daemon starts from instead of an empty one.
  seed?: string;
  // Config rows written into the seeded store before the daemon boots.
  config?: Record<string, unknown>;
  // A built CLI other than this tree's, so one run can compare two builds.
  cli?: string;
}): Promise<Sandbox> {
  const cli = opts.cli ? resolve(opts.cli) : resolve(REPO_ROOT, "dist/cli.mjs");
  if (!existsSync(cli)) throw new Error(`${cli} not found; run npm run build first`);
  const ports = instancePorts(opts.instance);
  const busy = await Promise.all(ports.map(isListening));
  const taken = ports.filter((_, i) => busy[i]);
  if (taken.length > 0) {
    throw new Error(`port ${taken.join(", ")} already in use; pick another --instance`);
  }
  const baseUrl = `http://localhost:${ports[0]}`;

  const root = resolve(REPO_ROOT, "tmp/eval-sandbox");
  const dir = resolve(root, `instance-${opts.instance}`);
  const logPath = resolve(root, `instance-${opts.instance}.log`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "home"), { recursive: true });
  const log = openSync(logPath, "w");

  const sqlitePath = resolve(dir, "agentmemory.sqlite");
  if (opts.seed) copyFileSync(opts.seed, sqlitePath);
  if (opts.config) {
    const db = new DatabaseSync(sqlitePath);
    try {
      const put = db.prepare(
        `INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      for (const [key, value] of Object.entries(opts.config)) put.run(KV.config, key, JSON.stringify(value), Date.now());
    } finally {
      db.close();
    }
  }
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "--instance", String(opts.instance)],
    {
      env: sandboxEnv(
        resolve(dir, "home"),
        sqlitePath,
        resolve(root, "models"),
        opts.embeddings,
        opts.llm === true,
        opts.compress !== false,
        opts.derived === true,
      ),
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;

  // A shutdown that stalls must not hang CI, so SIGTERM gets a bounded grace.
  const stop = async () => {
    if (!hasExited()) {
      child.kill("SIGTERM");
      const grace = new Promise<"stalled">((done) =>
        setTimeout(() => done("stalled"), STOP_GRACE_MS).unref(),
      );
      if ((await Promise.race([exited, grace])) === "stalled") {
        child.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + (opts.seed ? SEEDED_BOOT_TIMEOUT_MS : BOOT_TIMEOUT_MS);
  while (!(await isUp(baseUrl, Math.max(500, deadline - Date.now())))) {
    if (hasExited() || Date.now() > deadline) {
      await stop();
      throw new Error(`sandbox daemon on ${baseUrl} did not come up; see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const vectorsFilled = async () => {
    if (opts.embeddings === "none") return;
    const deadline = Date.now() + VECTOR_FILL_TIMEOUT_MS;
    while (!readFileSync(logPath, "utf8").includes("index-fill-missing finished")) {
      if (hasExited() || Date.now() > deadline) throw new Error(`sandbox on ${baseUrl} never finished its vector fill; see ${logPath}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  return { baseUrl, sqlitePath, logPath, vectorsFilled, stop };
}
