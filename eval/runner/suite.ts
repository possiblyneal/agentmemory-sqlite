import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { PmbRow } from "./pmb-score.js";
import type { SessionScore } from "./replay-score.js";
import { HOLDOUT_ENV, HOLDOUT_LEDGER, type Split } from "./split.js";
import { pairedBootstrap, pooled, type Comparison, type ItemMetrics, type Ratio } from "./suite-stats.js";
import type { ScoreRow } from "./types.js";

type Tier = "fast" | "full";

// Each bench owns a sandbox instance (ports 3111 + 100 * instance); longmemeval
// takes 10-12, one per worker. Instance 7 is left for a live daemon.
interface Bench {
  name: string;
  tiers: Tier[];
  instance: number;
  // An env var naming the bench's data, checked before anything runs.
  input?: { env: string; hint: string };
  args(tier: Tier, split: Split, input: string): string[];
  metrics(out: string): ItemMetrics;
  lowerIsBetter?: string[];
}

interface RunMeta {
  label: string;
  commit: string;
  dirty: boolean;
  tier: Tier;
  split: Split;
  startedAt: string;
  config: Record<string, string>;
  benches: Record<string, { exitCode: number | null; seconds: number }>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS = join(REPO_ROOT, "tmp/eval-suite");
// What changes Recall without changing code; a comparison names any that differ.
const CONFIG_KEYS = [
  "AGENTMEMORY_PROMPT_RERANK",
  "AGENTMEMORY_PROMPT_RERANK_URL",
  "AGENTMEMORY_PROMPT_RERANK_MIN",
  "EMBEDDING_PROVIDER",
  "OPENAI_EMBEDDING_MODEL",
  "LONGMEMEVAL_PATH",
  "AGENTMEMORY_EVAL_REPLAY_PROJECTS",
];

function readNdjson<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function addItem(metrics: ItemMetrics, metric: string, id: string, ratio: Ratio): void {
  (metrics[metric] ??= {})[id] = ratio;
}

const one = (x: number | boolean): Ratio => ({ num: Number(x), den: 1 });

const BENCHES: Bench[] = [
  {
    name: "coding-life",
    tiers: ["fast", "full"],
    instance: 3,
    args: () => ["eval/runner/coding-life.ts", "--adapters", "agentmemory"],
    metrics(out) {
      const metrics: ItemMetrics = {};
      for (const row of readNdjson<ScoreRow>(join(out, "scores.ndjson"))) {
        if (row.recall !== null) addItem(metrics, `${row.path}.recall`, row.questionId, one(row.recall));
        addItem(metrics, `${row.path}.precision`, row.questionId, one(row.precision));
        addItem(metrics, `${row.path}.hit`, row.questionId, one(row.hit));
      }
      return metrics;
    },
  },
  {
    name: "pmb",
    tiers: ["fast", "full"],
    instance: 4,
    args: () => ["eval/runner/pmb.ts"],
    metrics(out) {
      const metrics: ItemMetrics = {};
      for (const row of readNdjson<PmbRow>(join(out, "scores.ndjson"))) {
        addItem(metrics, "pass", row.caseId, one(row.pass));
        if (row.passType === "active") addItem(metrics, "activePass", row.caseId, one(row.activePass));
        if (row.precision !== null) addItem(metrics, "precision", row.caseId, one(row.precision));
        if (row.recall !== null) addItem(metrics, "recall", row.caseId, one(row.recall));
      }
      return metrics;
    },
  },
  {
    name: "longmemeval",
    tiers: ["fast", "full"],
    instance: 10,
    input: { env: "LONGMEMEVAL_PATH", hint: "longmemeval_s.json" },
    // A holdout look is rare, so it always takes the larger sample.
    args: (tier, split, data) => [
      "eval/runner/longmemeval.ts",
      "--data", data,
      "--adapters", "agentmemory",
      "--stratify", tier === "fast" && split === "dev" ? "4" : "20",
      "--concurrency", "3",
    ],
    metrics(out) {
      const metrics: ItemMetrics = {};
      for (const row of readNdjson<ScoreRow>(join(out, "scores.ndjson"))) {
        if (row.recall !== null) addItem(metrics, "recall@5", row.questionId, one(row.recall));
        addItem(metrics, "hit", row.questionId, one(row.hit));
      }
      return metrics;
    },
  },
  {
    name: "replay",
    tiers: ["full"],
    instance: 9,
    input: { env: "AGENTMEMORY_EVAL_REPLAY_PROJECTS", hint: "the comma-separated ~/.claude/projects directories to replay" },
    args: (_tier, _split, projects) => ["eval/runner/replay.ts", "--projects", projects],
    metrics(out) {
      const metrics: ItemMetrics = {};
      for (const s of readNdjson<SessionScore>(join(out, "scores.ndjson"))) {
        const used = s.items.filter((i) => i.used).length;
        addItem(metrics, "usedShare", s.sessionId, { num: used, den: s.items.length });
        addItem(metrics, "injection", s.sessionId, { num: s.outcomes.filter((o) => o.injected).length, den: s.outcomes.length });
        addItem(metrics, "leakShare", s.sessionId, { num: s.items.filter((i) => i.leak).length, den: s.items.length });
        addItem(metrics, "charsPerUsedItem", s.sessionId, { num: s.injectionChars, den: used });
      }
      return metrics;
    },
    lowerIsBetter: ["leakShare", "charsPerUsedItem"],
  },
];

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function runBench(bench: Bench, tier: Tier, split: Split, dir: string, input: string): Promise<number | null> {
  const out = join(dir, bench.name);
  mkdirSync(out, { recursive: true });
  const log = openSync(join(dir, `${bench.name}.log`), "w");
  const args = [...bench.args(tier, split, input), "--instance", String(bench.instance), "--split", split, "--out", out];
  const child = spawn(join(REPO_ROOT, "node_modules/.bin/tsx"), args, { cwd: REPO_ROOT, stdio: ["ignore", log, log] });
  closeSync(log);
  return new Promise((done) => child.once("exit", (code) => done(code)));
}

const fmt = (x: number | null, digits = 3) => (x === null ? "—" : x.toFixed(digits));

function compare(dir: string, againstDir: string, benches: Bench[], meta: RunMeta): boolean {
  const before = JSON.parse(readFileSync(join(againstDir, "meta.json"), "utf8")) as RunMeta;
  const changed = CONFIG_KEYS.filter((k) => (before.config[k] ?? "") !== (meta.config[k] ?? ""));
  console.log(`\n=== ${meta.label} vs ${before.label} ===`);
  if (changed.length > 0) console.log(`  config differs: ${changed.map((k) => `${k} ${before.config[k] ?? "∅"} → ${meta.config[k] ?? "∅"}`).join(", ")}`);
  const pairs: Array<{ bench: Bench; metric: string; base: Record<string, Ratio>; cand: Record<string, Ratio> }> = [];
  for (const bench of benches) {
    if (!existsSync(join(againstDir, bench.name, "scores.ndjson")) || !existsSync(join(dir, bench.name, "scores.ndjson"))) continue;
    const base = bench.metrics(join(againstDir, bench.name));
    const cand = bench.metrics(join(dir, bench.name));
    for (const metric of Object.keys(cand)) if (base[metric]) pairs.push({ bench, metric, base: base[metric], cand: cand[metric] });
  }
  // Bonferroni: one comparison in twenty would flag a change by chance at 0.05.
  const alpha = 0.05 / Math.max(1, pairs.length);
  console.log(`  ${pairs.length} metrics, ${((1 - alpha) * 100).toFixed(1)}% intervals`);
  const report: Record<string, Record<string, Comparison>> = {};
  let worse = false;
  for (const { bench, metric, base, cand } of pairs) {
    const c = pairedBootstrap(base, cand, bench.lowerIsBetter?.includes(metric), alpha);
    (report[bench.name] ??= {})[metric] = c;
    worse ||= c.verdict === "worse";
    console.log(
      `  ${`${bench.name}.${metric}`.padEnd(32)} ${fmt(c.base)} → ${fmt(c.cand)}  Δ ${fmt(c.delta)} [${fmt(c.low)}, ${fmt(c.high)}] n=${c.n}  ${c.verdict}`,
    );
  }
  writeFileSync(join(dir, `compare-${before.label}.json`), JSON.stringify(report, null, 2));
  return !worse;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tier: { type: "string", default: "fast" },
      against: { type: "string" },
      label: { type: "string" },
      holdout: { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
    },
  });
  const tier = values.tier as Tier;
  if (tier !== "fast" && tier !== "full") throw new Error(`--tier must be fast or full, got: ${values.tier}`);
  const benches = BENCHES.filter((b) => b.tiers.includes(tier));
  const inputs: Record<string, string> = {};
  for (const { name, input } of benches) {
    if (!input) continue;
    const value = process.env[input.env];
    if (!value) throw new Error(`set ${input.env} to ${input.hint}`);
    inputs[name] = value;
  }

  const commit = git("rev-parse", "--short", "HEAD");
  // Holdout looks append to the ledger, which must not mark the next run dirty.
  const dirty = git("status", "--porcelain", "--", ".", `:!${relative(REPO_ROOT, HOLDOUT_LEDGER)}`).length > 0;
  const split: Split = values.holdout ? "holdout" : "dev";
  const suffix = values.holdout ? "-holdout" : "";
  const label = `${values.label ?? `${commit}${dirty ? "-dirty" : ""}`}-${tier}${suffix}`;
  const meta: RunMeta = {
    label,
    commit,
    dirty,
    tier,
    split,
    startedAt: new Date().toISOString(),
    config: Object.fromEntries(CONFIG_KEYS.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
    benches: {},
  };
  const dir = join(RUNS, label);
  const againstDir = values.against ? join(RUNS, `${values.against}-${tier}${suffix}`) : undefined;
  if (againstDir === dir) throw new Error(`--label ${values.label} would overwrite the --against run`);
  if (againstDir && !existsSync(join(againstDir, "meta.json"))) throw new Error(`no run at ${againstDir}`);

  // Each runner logs its own look in the ledger under this label.
  if (values.holdout) process.env[HOLDOUT_ENV] = label;
  if (!values["no-build"]) execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`${label}: ${benches.map((b) => b.name).join(", ")} → ${dir}`);
  await Promise.all(
    benches.map(async (bench) => {
      const t0 = Date.now();
      const exitCode = await runBench(bench, tier, split, dir, inputs[bench.name] ?? "");
      meta.benches[bench.name] = { exitCode, seconds: Math.round((Date.now() - t0) / 1000) };
      console.log(`  ${bench.name} ${exitCode === 0 ? "done" : `FAILED (exit ${exitCode}, see ${bench.name}.log)`} in ${meta.benches[bench.name].seconds}s`);
    }),
  );
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  const ok = benches.filter((b) => meta.benches[b.name].exitCode === 0);
  const summary: Record<string, Record<string, { n: number; value: number | null }>> = {};
  console.log("\n=== Scores ===");
  for (const bench of ok) {
    for (const [metric, items] of Object.entries(bench.metrics(join(dir, bench.name)))) {
      const value = pooled(items);
      (summary[bench.name] ??= {})[metric] = { n: Object.keys(items).length, value };
      console.log(`  ${`${bench.name}.${metric}`.padEnd(32)} ${fmt(value)}  n=${Object.keys(items).length}`);
    }
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));

  const comparedOk = againstDir ? compare(dir, againstDir, ok, meta) : true;
  if (ok.length < benches.length || !comparedOk) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
