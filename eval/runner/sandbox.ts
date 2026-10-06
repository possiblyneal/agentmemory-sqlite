import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EmbeddingMode = "local" | "none";

export interface Sandbox {
  baseUrl: string;
  sqlitePath: string;
  stop(): Promise<void>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOT_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 10_000;

// Mirrors `--instance N` in src/cli.ts: REST anchors the block, streams and
// the viewer sit at REST+1 and REST+2.
function instancePorts(instance: number): number[] {
  const rest = 3111 + instance * 100;
  return [rest, rest + 1, rest + 2];
}

function isListening(port: number): Promise<boolean> {
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

async function isUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/agentmemory/livez`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The daemon reads ~/.agentmemory/.env and inherits provider keys from the
// shell, so the sandbox gets its own HOME under the repo's tmp/ and an env
// built from scratch: no LLM provider (synthetic compression, no summaries)
// and only the embedding provider the run asks for. A shell that sets
// EMBEDDING_PROVIDER and OPENAI_EMBEDDING_* picks a remote embedder for every
// run that uses embeddings at all; the endpoint is never written in the repo.
function sandboxEnv(home: string, sqlitePath: string, embeddings: EmbeddingMode) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    AGENTMEMORY_SQLITE_PATH: sqlitePath,
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HF_") && value !== undefined) env[key] = value;
  }
  if (embeddings === "local") env.EMBEDDING_PROVIDER = "local";
  if (embeddings !== "none") {
    for (const [key, value] of Object.entries(process.env)) {
      const forwarded = key === "EMBEDDING_PROVIDER" || key.startsWith("OPENAI_EMBEDDING_");
      if (forwarded && value !== undefined) env[key] = value;
    }
  }
  if (process.env.RERANK_ENABLED) env.RERANK_ENABLED = process.env.RERANK_ENABLED;
  return env;
}

export async function startSandbox(opts: {
  instance: number;
  embeddings: EmbeddingMode;
}): Promise<Sandbox> {
  const cli = resolve(REPO_ROOT, "dist/cli.mjs");
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
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "--instance", String(opts.instance)],
    {
      env: sandboxEnv(resolve(dir, "home"), sqlitePath, opts.embeddings),
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

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!(await isUp(baseUrl))) {
    if (hasExited() || Date.now() > deadline) {
      await stop();
      throw new Error(`sandbox daemon on ${baseUrl} did not come up; see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { baseUrl, sqlitePath, stop };
}
