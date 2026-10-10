import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { daemonCall } from "./daemon-http.js";
import {
  beliefToText,
  budgetOf,
  DEFAULT_USER_ID,
  scoreCase,
  summarizePmb,
  type Belief,
  type PmbCase,
  type PmbRow,
} from "./pmb-score.js";
import { startSandbox, type EmbeddingMode } from "./sandbox.js";
import { parseSplit, selectSplit } from "./split.js";

interface CliOptions {
  data: string;
  out: string;
  instance: string;
  embeddings: string;
  split?: string;
}

function parse(): CliOptions {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: "eval/data/precisionmembench" },
      out: { type: "string", default: "eval/reports/pmb" },
      instance: { type: "string", default: "4" },
      embeddings: { type: "string", default: "local" },
      split: { type: "string" },
    },
  });
  return values as unknown as CliOptions;
}

const fmt = (x: number | null) => (x === null ? "—" : x.toFixed(3));

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
  const beliefs = JSON.parse(readFileSync(resolve(opts.data, "beliefs.seed.json"), "utf8")) as Belief[];
  const allCases = JSON.parse(readFileSync(resolve(opts.data, "retrieval.cases.json"), "utf8")) as PmbCase[];
  const cases = selectSplit("pmb", allCases, parseSplit(opts.split), (c) => c.caseId, (c) => c.category);
  console.log(`loaded ${beliefs.length} beliefs, ${cases.length} cases`);

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = `${outDir}/scores.ndjson`;
  writeFileSync(ndjsonPath, "");

  // Each user is its own project, so the cross-user cases test project scope.
  const sandbox = await startSandbox({ instance, embeddings: opts.embeddings as EmbeddingMode });
  const rows: PmbRow[] = [];
  try {
    const memoryToBelief = new Map<string, string>();
    for (const b of beliefs) {
      const { body } = await daemonCall<{ memory?: { id?: string } }>(sandbox.baseUrl, "remember", {
        body: { content: beliefToText(b), project: b.user_id },
      });
      if (body.memory?.id) memoryToBelief.set(body.memory.id, b._id);
    }
    for (const c of cases) {
      // Upstream's buildContext never searches a blank query or a zero budget.
      const { body, ms } =
        c.query.trim() && budgetOf(c).maxBeliefs > 0
          ? await daemonCall<{ results?: Array<{ obsId?: string }> }>(sandbox.baseUrl, "smart-search", {
              body: { query: c.query, project: c.userId ?? DEFAULT_USER_ID, limit: budgetOf(c).maxBeliefs },
            })
          : { body: { results: [] }, ms: 0 };
      const searched = [
        ...new Set((body.results ?? []).flatMap((r) => memoryToBelief.get(r.obsId ?? "") ?? [])),
      ];
      const row = scoreCase(c, beliefs, searched, ms);
      rows.push(row);
      appendFileSync(ndjsonPath, `${JSON.stringify(row)}\n`);
      console.log(
        `  ${row.pass ? "+" : "-"} ${c.caseId} [${row.passType}] P=${fmt(row.precision)} R=${fmt(row.recall)}` +
          (row.pass ? "" : ` ${row.failures.slice(0, 2).join("; ")}`),
      );
    }
  } finally {
    await sandbox.stop();
  }

  const summary = summarizePmb(rows);
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(
    `\n=== Summary ===\n  active ${summary.activePass}/${summary.active}  total ${summary.pass}/${summary.n}  ` +
      `precision ${fmt(summary.precision)}  recall ${fmt(summary.recall)}\n\nwrote ${ndjsonPath}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
