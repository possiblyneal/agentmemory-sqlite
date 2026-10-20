import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { daemonCall } from "./daemon-http.js";
import { startSandbox, type EmbeddingMode } from "./sandbox.js";
import { openSplit, selectSplit } from "./split.js";
import { buildCases, type EvalCase, type SeedRow, type Step } from "./supersession-cases.js";
import { classify, summarize, type CellSummary, type ScoreRow } from "./supersession-score.js";

interface CliOptions {
  out: string;
  instance: string;
  embeddings: string;
  split?: string;
}

function parse(): CliOptions {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: "eval/reports/supersession" },
      instance: { type: "string", default: "5" },
      embeddings: { type: "string", default: "none" },
      split: { type: "string" },
    },
  });
  return values as unknown as CliOptions;
}

const KV_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  seq        INTEGER PRIMARY KEY,
  scope      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, key)
);
CREATE INDEX IF NOT EXISTS kv_scope_seq ON kv(scope, seq);
`;

function writeSeed(path: string, rows: SeedRow[]): void {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(KV_SCHEMA);
    const put = db.prepare("INSERT OR REPLACE INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, ?)");
    const at = Date.now();
    for (const row of rows) put.run(row.scope, row.key, JSON.stringify(row.value), at);
  } finally {
    db.close();
  }
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  return (await daemonCall<T>(baseUrl, path, { body })).body;
}

async function runSteps(baseUrl: string, c: EvalCase): Promise<void> {
  let memoryId: string | undefined;
  for (const step of c.steps) {
    memoryId = await runStep(baseUrl, c, step, memoryId);
  }
}

async function runStep(baseUrl: string, c: EvalCase, step: Step, memoryId: string | undefined): Promise<string | undefined> {
  if (step.op === "remember") {
    const { memory } = await post<{ memory?: { id?: string } }>(baseUrl, "remember", { content: step.content, project: c.project });
    return memory?.id;
  }
  if (step.op === "lesson") {
    await post(baseUrl, "lessons", { content: step.content, project: c.project });
    return memoryId;
  }
  if (!memoryId) throw new Error(`${c.id}: evolve before any remember`);
  await post(baseUrl, "evolve", { memoryId, newContent: step.newContent, newTitle: step.newContent });
  return memoryId;
}

// What the surface put in front of the Agent, in the order it is read.
async function probe(baseUrl: string, c: EvalCase): Promise<string[]> {
  const sessionId = `${c.project}-now`;
  const { probe: p } = c;
  if (p.via === "context") {
    const { context } = await post<{ context?: string }>(baseUrl, "context", { sessionId, project: c.project });
    return [context ?? ""];
  }
  if (p.via === "prompt") {
    const { context } = await post<{ context?: string }>(baseUrl, "prompt-context", { sessionId, project: c.project, prompt: p.prompt });
    return [context ?? ""];
  }
  const body = await post<Record<string, unknown>>(baseUrl, "smart-search", { query: p.query, project: c.project });
  const list = body[p.list];
  return Array.isArray(list) ? list.map((item) => JSON.stringify(item)) : [];
}

const fmt = (x: number | null) => (x === null ? "—" : x.toFixed(2));

function printSummary(cells: CellSummary[]): void {
  console.log(
    `  ${"kind".padEnd(18)} ${"variant".padEnd(14)} ${"surface".padEnd(14)} ${"n".padStart(3)} ${"stale-1st".padStart(9)} ${"fresh-1st".padStart(9)} ${"hidden".padStart(6)} ${"neither".padStart(7)} ${"rate".padStart(5)}`,
  );
  for (const s of cells) {
    console.log(
      `  ${s.kind.padEnd(18)} ${(s.variant ?? "(all)").padEnd(14)} ${s.surface.padEnd(14)} ${String(s.n).padStart(3)} ${String(s.staleFirst).padStart(9)} ${String(s.freshFirst).padStart(9)} ${String(s.staleHidden).padStart(6)} ${String(s.neither).padStart(7)} ${fmt(s.staleFirstRate).padStart(5)}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parse();
  const instance = Number(opts.instance);
  if (!Number.isInteger(instance) || instance < 1) {
    console.error(`--instance must be a positive integer, got: ${opts.instance}`);
    process.exit(2);
  }
  if (opts.embeddings !== "local" && opts.embeddings !== "none") {
    console.error(`--embeddings must be local or none, got: ${opts.embeddings}`);
    process.exit(2);
  }
  const cases = selectSplit(
    "supersession",
    buildCases(new Date()),
    openSplit(opts.split, "supersession"),
    (c) => c.id,
    (c) => c.group,
  );
  console.log(`loaded ${cases.length} cases`);

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = `${outDir}/scores.ndjson`;
  writeFileSync(ndjsonPath, "");

  const seedPath = resolve("tmp/eval-supersession", `seed-${instance}.sqlite`);
  mkdirSync(resolve("tmp/eval-supersession"), { recursive: true });
  writeSeed(seedPath, cases.flatMap((c) => c.rows));

  const sandbox = await startSandbox({ instance, embeddings: opts.embeddings as EmbeddingMode, seed: seedPath });
  const rows: ScoreRow[] = [];
  try {
    await sandbox.vectorsFilled();
    for (const c of cases) {
      await runSteps(sandbox.baseUrl, c);
      const returned = await probe(sandbox.baseUrl, c);
      const row: ScoreRow = {
        caseId: c.id,
        kind: c.kind,
        variant: c.variant,
        surface: c.surface,
        outcome: classify(returned, c.stale, c.fresh),
      };
      rows.push(row);
      appendFileSync(ndjsonPath, `${JSON.stringify(row)}\n`);
      console.log(`  ${row.outcome.padEnd(12)} ${c.id}`);
    }
  } finally {
    await sandbox.stop();
    rmSync(seedPath, { force: true });
  }

  const summary = summarize(rows);
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log("\n=== Summary: stale-first rate per record kind and surface ===");
  printSummary(summary);
  console.log(`\nwrote ${ndjsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
