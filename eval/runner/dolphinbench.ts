import { mkdirSync } from "node:fs";
import { appendDurable, startNdjson, writeJsonAtomic } from "./durable.js";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentmemoryAdapter } from "./adapters/agentmemory.js";
import { grepAdapter } from "./adapters/grep.js";
import { vectorAdapter } from "./adapters/vector.js";
import { loadDolphinBench } from "./dolphinbench-load.js";
import { aggregate, scoreQuestion } from "./score.js";
import { openSplit, selectSplit } from "./split.js";
import type { Adapter, QuestionPath, ScoreRow } from "./types.js";

const ADAPTERS: Record<string, Adapter> = {
  grep: grepAdapter,
  vector: vectorAdapter,
  agentmemory: agentmemoryAdapter,
};

// Alex (infrastructure engineer) is the nearest to a coding agent, so it runs first.
const PERSONA_ORDER = ["alex"];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values: opts } = parseArgs({
    options: {
      data: { type: "string", default: process.env.DOLPHINBENCH_PATH ?? "" },
      adapters: { type: "string", default: "grep,agentmemory" },
      paths: { type: "string", default: "search,prompt-submit" },
      persona: { type: "string" },
      k: { type: "string", default: "5" },
      split: { type: "string" },
      instance: { type: "string", default: "3" },
      out: { type: "string", default: "eval/reports/dolphinbench" },
      resume: { type: "boolean", default: false },
    },
  });
  if (!opts.data) fail("--data <path/to/dolphinbench> required (or DOLPHINBENCH_PATH env)");
  const k = Number(opts.k);
  const instance = Number(opts.instance);
  if (!Number.isInteger(k) || k <= 0) fail(`--k must be a positive integer, got: ${opts.k}`);
  if (!Number.isInteger(instance) || instance < 1) fail(`--instance must be a positive integer, got: ${opts.instance}`);
  const adapterNames = opts.adapters.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of adapterNames) if (!ADAPTERS[a]) fail(`unknown adapter: ${a}. options: ${Object.keys(ADAPTERS).join(",")}`);
  const paths = opts.paths.split(",").map((s) => s.trim()).filter(Boolean) as QuestionPath[];
  for (const p of paths) if (p !== "search" && p !== "prompt-submit") fail(`--paths takes search and prompt-submit, got: ${p}`);

  const all = selectSplit(
    "dolphinbench",
    await loadDolphinBench(resolve(opts.data)),
    openSplit(opts.split, "dolphinbench"),
    (q) => q.id,
    (q) => q.type,
  );
  const personas = [...new Set(all.map((q) => q.type))]
    .filter((p) => !opts.persona || p === opts.persona)
    .sort((a, b) => (PERSONA_ORDER.indexOf(b) + 1) - (PERSONA_ORDER.indexOf(a) + 1) || a.localeCompare(b));
  if (personas.length === 0) fail(`no persona matches --persona ${opts.persona}`);

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = `${outDir}/scores.ndjson`;
  const rows = startNdjson<ScoreRow>(ndjsonPath, opts.resume === true);
  if (rows.some((r) => r.k !== k)) fail(`${ndjsonPath} was scored at another --k; remove it or pass its own options`);
  const finished = new Set(rows.map((r) => `${r.adapter}:${r.path}:${r.questionId}`));
  if (finished.size > 0) console.log(`--resume: ${finished.size} questions already scored`);

  // A persona's history is ingested once and every test of it queries that store.
  for (const persona of personas) {
    const questions = all.filter((q) => q.type === persona);
    console.log(`\n=== ${persona}: ${questions.length} tests, ${questions[0].haystack.length} messages, k=${k} ===`);
    for (const adapterName of adapterNames) {
      const adapter = ADAPTERS[adapterName];
      const adapterPaths = paths.filter((p) => adapter.paths.includes(p));
      const remaining = (path: QuestionPath) => questions.filter((q) => !finished.has(`${adapter.name}:${path}:${q.id}`));
      if (adapterPaths.every((p) => remaining(p).length === 0)) continue;
      const t0 = performance.now();
      const state = await adapter.init(questions[0].haystack, {
        instance,
        baseUrl: process.env.AGENTMEMORY_BASE_URL,
      });
      console.log(`${adapter.name}: ingested in ${Math.round((performance.now() - t0) / 1000)}s`);
      try {
        for (const path of adapterPaths) {
          for (const q of remaining(path)) {
            const t1 = performance.now();
            const result = await adapter.query({ ...q, path }, state, k);
            const row = scoreQuestion({ ...q, path }, result, k, adapter.name, performance.now() - t1);
            rows.push(row);
            appendDurable(ndjsonPath, row);
          }
          const ids = new Set(questions.map((q) => q.id));
          const personaRows = rows.filter((r) => r.adapter === adapter.name && r.path === path && ids.has(r.questionId));
          const s = aggregate(personaRows).byPath[adapter.name][path];
          console.log(
            `  ${adapter.name}/${path} P@${k}=${s.precision.toFixed(3)} R@${k}=${s.recall.toFixed(3)} hit=${s.hit}/${s.n} p50=${Math.round(s.latencyP50)}ms`,
          );
        }
      } finally {
        if (adapter.teardown) await adapter.teardown(state);
      }
    }
  }

  const summaryPath = `${outDir}/summary.json`;
  writeJsonAtomic(summaryPath, aggregate(rows));
  console.log(`\nwrote ${ndjsonPath}\nwrote ${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
