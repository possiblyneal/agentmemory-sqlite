import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcnemarExact, pairDecisions, refuseFailedSummaries, type DecisionRow } from "./compare-core.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ARMS = join(REPO_ROOT, "tmp", "eval-arms");

interface Summary {
  run: { checkpoints?: string; llm?: { failedSummarizeCalls?: number } };
  summary: Record<string, unknown>;
}

interface LoadedRun {
  label: string;
  rows: DecisionRow[];
  summary: Summary;
  failedSummarizeCalls: number | undefined;
}

// A path to a probe output directory, or the label of an `eval:arm` run.
function resolveRunDir(arg: string): string {
  const candidates = [resolve(arg), join(ARMS, arg, "probe")];
  const dir = candidates.find((d) => existsSync(join(d, "scores.ndjson")) && existsSync(join(d, "summary.json")));
  if (!dir) throw new Error(`no probe output (scores.ndjson + summary.json) at ${candidates.join(" or ")}`);
  return dir;
}

function loadRun(arg: string): LoadedRun {
  const dir = resolveRunDir(arg);
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as Summary;
  const rows = readFileSync(join(dir, "scores.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionRow);
  // A probe pass summarizes nothing; the failures belong to the save pass it probed.
  const runJson = summary.run.checkpoints && join(summary.run.checkpoints, "run.json");
  const saved = runJson && existsSync(runJson) ? (JSON.parse(readFileSync(runJson, "utf8")) as Summary["run"]) : undefined;
  const failedSummarizeCalls = summary.run.llm?.failedSummarizeCalls ?? saved?.llm?.failedSummarizeCalls;
  return { label: arg, rows, summary, failedSummarizeCalls };
}

const SKIPPED_BRANCHES = new Set(["byProject", "typical", "byKind"]);

function numericLeaves(value: unknown, path: string[] = [], out = new Map<string, number>()): Map<string, number> {
  if (typeof value === "number") out.set(path.join("."), value);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) if (!SKIPPED_BRANCHES.has(key)) numericLeaves(child, [...path, key], out);
  }
  return out;
}

function main() {
  const [a, b, ...extra] = process.argv.slice(2);
  if (!a || !b || extra.length > 0) {
    console.error("usage: npm run eval:compare -- <dirA|labelA> <dirB|labelB>");
    process.exit(2);
  }
  const runs = [loadRun(a), loadRun(b)];
  const refusal = refuseFailedSummaries(runs);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  const [runA, runB] = runs;
  const p = pairDecisions(runA.rows, runB.rows);
  console.log(`decision items delivered by either surface, ${p.both + p.aOnly + p.bOnly + p.neither} paired reachable items`);
  console.log(`  A ${runA.label}: ${p.aDelivered}`);
  console.log(`  B ${runB.label}: ${p.bDelivered}`);
  console.log(`  both ${p.both}   A-only ${p.aOnly}   B-only ${p.bOnly}   neither ${p.neither}`);
  console.log(`  exact McNemar p (two-sided) = ${mcnemarExact(p.aOnly, p.bOnly).toPrecision(3)}`);

  const left = numericLeaves(runA.summary.summary);
  const right = numericLeaves(runB.summary.summary);
  console.log("\nreplay metrics (A | B)");
  for (const [key, av] of left) {
    const bv = right.get(key);
    if (bv !== undefined) console.log(`  ${key.padEnd(48)} ${String(av).padStart(14)} | ${bv}`);
  }
}

main();
