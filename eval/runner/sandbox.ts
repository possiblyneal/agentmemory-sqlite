import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EmbeddingMode = "local" | "none";

export interface Sandbox {
  baseUrl: string;
  stop(): Promise<void>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOT_TIMEOUT_MS = 30_000;

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
// and only the embedding provider the run asks for.
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
  return env;
}

export async function startSandbox(opts: {
  instance: number;
  embeddings: EmbeddingMode;
}): Promise<Sandbox> {
  const cli = resolve(REPO_ROOT, "dist/cli.mjs");
  if (!existsSync(cli)) throw new Error(`${cli} not found; run npm run build first`);
  const baseUrl = `http://localhost:${3111 + opts.instance * 100}`;
  if (await isUp(baseUrl)) {
    throw new Error(`a daemon already answers on ${baseUrl}; pick another --instance`);
  }

  const root = resolve(REPO_ROOT, "tmp/eval-sandbox");
  const dir = resolve(root, `instance-${opts.instance}`);
  const logPath = resolve(root, `instance-${opts.instance}.log`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "home"), { recursive: true });
  const log = openSync(logPath, "w");

  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "--instance", String(opts.instance)],
    {
      env: sandboxEnv(resolve(dir, "home"), resolve(dir, "agentmemory.sqlite"), opts.embeddings),
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  const exited = new Promise<void>((done) => child.once("exit", () => done()));

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!(await isUp(baseUrl))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`sandbox daemon on ${baseUrl} did not come up; see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { baseUrl, stop };
}
