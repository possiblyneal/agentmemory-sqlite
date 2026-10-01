import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentmemoryAdapter } from "./adapters/agentmemory.js";
import { grepAdapter } from "./adapters/grep.js";
import { randomAdapter } from "./adapters/random.js";
import { vectorAdapter } from "./adapters/vector.js";
import { aggregate, scoreQuestion } from "./score.js";
import { questionPath, type Adapter, type Question, type ScoreRow, type Session } from "./types.js";

const agentmemoryBm25: Adapter = {
  ...(agentmemoryAdapter as unknown as Adapter),
  name: "agentmemory-bm25",
  init: (sessions, config) => agentmemoryAdapter.init(sessions, { ...config, embeddings: "none" }),
};

const ADAPTERS: Record<string, Adapter> = {
  agentmemory: agentmemoryAdapter as unknown as Adapter,
  "agentmemory-bm25": agentmemoryBm25,
  grep: grepAdapter as unknown as Adapter,
  random: randomAdapter as unknown as Adapter,
  vector: vectorAdapter as unknown as Adapter,
};

interface CliOptions {
  data: string;
  adapters: string;
  k: string;
  out: string;
  instance: string;
  "base-url"?: string;
}

function parse(): CliOptions {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: "eval/data/coding-agent-life-v2" },
      adapters: { type: "string", default: "agentmemory,agentmemory-bm25,grep,random" },
      k: { type: "string", default: "5" },
      out: { type: "string", default: "eval/reports/coding-life" },
      instance: { type: "string", default: "3" },
      "base-url": { type: "string" },
    },
  });
  return values as unknown as CliOptions;
}

function fmt(x: number | null, digits = 3): string {
  return x === null ? "—" : x.toFixed(digits);
}

async function main(): Promise<void> {
  const opts = parse();
  const k = Number(opts.k);
  if (!Number.isInteger(k) || k <= 0) {
    console.error(`--k must be a positive integer, got: ${opts.k}`);
    process.exit(2);
  }
  const instance = Number(opts.instance);
  if (!Number.isInteger(instance) || instance < 1) {
    console.error(`--instance must be a positive integer, got: ${opts.instance}`);
    process.exit(2);
  }
  const sessions = JSON.parse(
    readFileSync(resolve(opts.data, "sessions.json"), "utf8"),
  ) as Session[];
  const queriesRaw = JSON.parse(
    readFileSync(resolve(opts.data, "queries.json"), "utf8"),
  ) as Array<Omit<Question, "haystack">>;
  const questions: Question[] = queriesRaw.map((q) => ({ ...q, haystack: sessions }));
  const adapterNames = opts.adapters.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of adapterNames) {
    if (!ADAPTERS[a]) {
      console.error(`unknown adapter: ${a}. options: ${Object.keys(ADAPTERS).join(",")}`);
      process.exit(2);
    }
  }
  console.log(
    `loaded ${sessions.length} sessions, ${questions.length} queries, adapters: ${adapterNames.join(",")}, k=${k}`,
  );

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = `${outDir}/scores.ndjson`;
  writeFileSync(ndjsonPath, "");

  const rows: ScoreRow[] = [];
  for (const adapterName of adapterNames) {
    const adapter = ADAPTERS[adapterName];
    console.log(`\n== ${adapter.name} ==`);
    const state = await adapter.init(sessions, { instance, baseUrl: opts["base-url"] });
    try {
      for (const q of questions) {
        if (!adapter.paths.includes(questionPath(q))) continue;
        const t0 = performance.now();
        const result = await adapter.query(q, state, k);
        const latencyMs = performance.now() - t0;
        const row = scoreQuestion(q, result, k, adapter.name, latencyMs);
        rows.push(row);
        appendFileSync(ndjsonPath, JSON.stringify(row) + "\n");
        const mark = row.hit ? "+" : "-";
        console.log(
          `  ${mark} ${q.id} [${row.path}/${q.type}] returned=${row.returned} recall=${fmt(row.recall, 2)} precision=${row.precision.toFixed(2)} (${Math.round(latencyMs)}ms)`,
        );
      }
    } finally {
      if (adapter.teardown) await adapter.teardown(state);
    }
  }

  const summary = aggregate(rows);
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log("\n=== Summary ===");
  console.log(
    `  ${"adapter".padEnd(18)} ${"path".padEnd(14)} ${"n".padStart(3)} ${"recall".padStart(7)} ${"precision".padStart(9)} ${"no-answer".padStart(9)} ${"hit".padStart(7)} ${"chars".padStart(7)} ${"p50".padStart(6)}`,
  );
  for (const [adapter, byPath] of Object.entries(summary)) {
    for (const [path, s] of Object.entries(byPath)) {
      console.log(
        `  ${adapter.padEnd(18)} ${path.padEnd(14)} ${String(s.n).padStart(3)} ${fmt(s.recall).padStart(7)} ${fmt(s.precision).padStart(9)} ${fmt(s.noAnswerClean).padStart(9)} ${`${s.hit}/${s.n}`.padStart(7)} ${(s.meanChars === null ? "—" : String(Math.round(s.meanChars))).padStart(7)} ${`${Math.round(s.latencyP50)}ms`.padStart(6)}`,
      );
    }
  }
  console.log(`\nwrote ${ndjsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
