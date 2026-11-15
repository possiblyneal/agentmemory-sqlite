import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fsyncPath, writeJsonAtomic } from "./durable.js";
import { daemonCall } from "./daemon-http.js";
import { latency, prng, summarizeRuns, type Call, type RunResult } from "./burst-core.js";
import { startSandbox } from "./sandbox.js";

// N Sessions opening together over a seeded store, as a Session burst reaches
// the daemon: each posts session/start, types a first prompt a second or three
// later, then works at a tool call every --think ms. Latencies are the hooks':
// a call still unanswered at INJECT_TIMEOUT_MS counts as late and is dropped
// by the client, and the daemon is left to finish it, as for a real hook.
const INJECT_TIMEOUT_MS = 1500;
const PROJECT = "burst-bench";
const CWD = "/work/burst-bench";
const SEED_SESSIONS = 12;

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "main" },
    cli: { type: "string" },
    sessions: { type: "string", default: "32" },
    observations: { type: "string", default: "20000" },
    runs: { type: "string", default: "3" },
    think: { type: "string", default: "3000" },
    spread: { type: "string", default: "2000" },
    duration: { type: "string", default: "30000" },
    instance: { type: "string", default: "47" },
    out: { type: "string", default: "tmp/eval-burst" },
    "max-load": { type: "string", default: "3" },
  },
});
const N = Number(values.sessions);
const OBSERVATIONS = Number(values.observations);
const RUNS = Number(values.runs);
const THINK_MS = Number(values.think);
const SPREAD_MS = Number(values.spread);
const DURATION_MS = Number(values.duration);
const INSTANCE = Number(values.instance);
const MAX_LOAD = Number(values["max-load"]);
const OUT = resolve(values.out!);
const SEED_FILE = join(OUT, `seed-${OBSERVATIONS}.sqlite`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load1 = () => Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);

// Chunks of this repository's own text, 1.5 to 6.5 KB, the size of a Read result.
function corpus(): string[] {
  const chunks: string[] = [];
  const rand = prng(7);
  for (const dir of ["src/functions", "src/state", "docs", "eval/runner"]) {
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.(ts|md)$/.test(f)) continue;
      const text = readFileSync(join(dir, f), "utf8");
      for (let at = 0; at < text.length; at += 2000 + Math.floor(rand() * 4000)) {
        chunks.push(text.slice(at, at + 1500 + Math.floor(rand() * 5000)));
      }
    }
  }
  return chunks;
}

function observeBody(sessionId: string, chunk: string, n: number) {
  return {
    hookType: "post_tool_use",
    sessionId,
    project: PROJECT,
    cwd: CWD,
    timestamp: new Date().toISOString(),
    data: { tool_name: "Read", tool_input: { file_path: `/work/burst-bench/f${n}.ts` }, tool_output: chunk },
  };
}

function promptFrom(chunk: string, rand: () => number): string {
  const words = chunk.match(/[A-Za-z]{5,}/g) ?? ["context"];
  return Array.from({ length: 7 }, () => words[Math.floor(rand() * words.length)]).join(" ");
}

async function buildSeed(chunks: string[]): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const sandbox = await startSandbox({ instance: INSTANCE, embeddings: "none", cli: values.cli });
  try {
    const rand = prng(11);
    const per = Math.ceil(OBSERVATIONS / SEED_SESSIONS);
    for (let s = 0; s < SEED_SESSIONS; s++) {
      const sessionId = `seed-${s}`;
      await daemonCall(sandbox.baseUrl, "session/start", { body: { sessionId, project: PROJECT, cwd: CWD } });
      for (let i = 0; i < per; i += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, per - i) }, (_, j) =>
            daemonCall(sandbox.baseUrl, "observe", {
              body: observeBody(sessionId, chunks[Math.floor(rand() * chunks.length)], i + j),
            }),
          ),
        );
      }
      await daemonCall(sandbox.baseUrl, "session/end", { body: { sessionId } });
      console.log(`seeded ${(s + 1) * per} Observations`);
    }
    await sleep(5000);
    const db = new DatabaseSync(sandbox.sqlitePath, { readOnly: true });
    const partial = `${SEED_FILE}.partial`;
    rmSync(partial, { force: true });
    try {
      db.prepare("VACUUM INTO ?").run(partial);
    } finally {
      db.close();
    }
    fsyncPath(partial);
    renameSync(partial, SEED_FILE);
    fsyncPath(OUT);
  } finally {
    await sandbox.stop();
  }
}

async function timed(baseUrl: string, path: string, body: unknown): Promise<Call> {
  const t0 = performance.now();
  try {
    await daemonCall(baseUrl, path, { body, timeoutMs: INJECT_TIMEOUT_MS });
    return { ms: performance.now() - t0, timedOut: false };
  } catch {
    return { ms: performance.now() - t0, timedOut: true };
  }
}

async function oneRun(chunks: string[], run: number): Promise<RunResult> {
  let loadBefore = load1();
  const waitUntil = Date.now() + 10 * 60_000;
  while (loadBefore > MAX_LOAD && Date.now() < waitUntil) {
    console.log(`load ${loadBefore.toFixed(1)} above ${MAX_LOAD}; waiting`);
    await sleep(15_000);
    loadBefore = load1();
  }
  const sandbox = await startSandbox({ instance: INSTANCE, embeddings: "none", seed: SEED_FILE, cli: values.cli });
  try {
    const base = sandbox.baseUrl;
    const first: Call[] = [];
    const starts: Call[] = [];
    const later: Call[] = [];
    const livez: number[] = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const t0 = performance.now();
        await daemonCall(base, "livez", { timeoutMs: 5000 }).catch(() => {});
        livez.push(performance.now() - t0);
        await sleep(50);
      }
    })();
    const rand = prng(1000 + run);
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const sessionId = `burst-${run}-${i}`;
        await sleep(rand() * SPREAD_MS);
        starts.push(await timed(base, "session/start", { sessionId, project: PROJECT, cwd: CWD }));
        await sleep(1000 + rand() * 2000);
        let step = 0;
        while (Date.now() - t0 < SPREAD_MS + DURATION_MS) {
          const chunk = chunks[Math.floor(rand() * chunks.length)];
          if (step % 8 === 0) {
            const prompt = promptFrom(chunk, rand);
            (step === 0 ? first : later).push(await timed(base, "prompt-context", { sessionId, project: PROJECT, prompt }));
            void daemonCall(base, "observe", {
              body: { ...observeBody(sessionId, "", step), hookType: "prompt_submit", data: { prompt } },
            }).catch(() => {});
          }
          void daemonCall(base, "observe", { body: observeBody(sessionId, chunk, step) }).catch(() => {});
          step++;
          await sleep(THINK_MS * (0.5 + rand()));
        }
        await daemonCall(base, "session/end", { body: { sessionId } }).catch(() => {});
      }),
    );
    polling = false;
    await poll;
    const sorted = livez.sort((a, b) => a - b);
    return {
      label: values.label!,
      run,
      loadBefore,
      sessions: N,
      firstPrompt: latency(first, INJECT_TIMEOUT_MS),
      sessionStart: latency(starts, INJECT_TIMEOUT_MS),
      laterPrompt: latency(later, INJECT_TIMEOUT_MS),
      livez: {
        n: sorted.length,
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        max: Math.round(sorted.at(-1) ?? 0),
      },
    };
  } finally {
    await sandbox.stop();
  }
}

async function main() {
  const dir = join(OUT, values.label!);
  mkdirSync(dir, { recursive: true });
  const chunks = corpus();
  if (!existsSync(SEED_FILE)) await buildSeed(chunks);
  const results: RunResult[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const file = join(dir, `run-${run}.json`);
    if (existsSync(file)) {
      results.push(JSON.parse(readFileSync(file, "utf8")) as RunResult);
      continue;
    }
    const result = await oneRun(chunks, run);
    writeJsonAtomic(file, result);
    results.push(result);
    console.log(
      `${values.label} run ${run}: load ${result.loadBefore.toFixed(1)}, first in time ${result.firstPrompt.inTime}/${result.firstPrompt.n} (p50 ${result.firstPrompt.p50} ms), session-start in time ${result.sessionStart.inTime}/${result.sessionStart.n}, later p95 ${result.laterPrompt.p95} ms, livez max ${result.livez.max} ms`,
    );
  }
  const summary = summarizeRuns(values.label!, results);
  writeJsonAtomic(join(dir, "summary.json"), summary);
  console.log(JSON.stringify(summary));
}

await main();
