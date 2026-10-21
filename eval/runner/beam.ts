import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentmemoryAdapter, agentmemoryBm25Adapter } from "./adapters/agentmemory.js";
import { grepAdapter } from "./adapters/grep.js";
import { loadBeam } from "./beam-load.js";
import { aggregate, scoreQuestion } from "./score.js";
import { openSplit, selectSplit } from "./split.js";
import type { Adapter, Question, ScoreRow } from "./types.js";

const ADAPTERS: Record<string, Adapter> = {
  grep: grepAdapter,
  agentmemory: agentmemoryAdapter,
  "agentmemory-bm25": agentmemoryBm25Adapter,
};

function positiveInts(flag: string, value: string): number[] {
  const out = value.split(",").filter(Boolean).map(Number);
  if (out.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error(`--${flag} must be positive integers, got: ${value}`);
    process.exit(2);
  }
  return out;
}

// One haystack per conversation: its Questions share the array the loader built.
function byConversation(questions: Question[]): Question[][] {
  const groups = new Map<Question["haystack"], Question[]>();
  for (const q of questions) groups.set(q.haystack, [...(groups.get(q.haystack) ?? []), q]);
  return [...groups.values()];
}

// Every Nth conversation, so a sample spans the file rather than its head.
function sampleEvenly<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: process.env.BEAM_PATH ?? "" },
      size: { type: "string", default: "100K" },
      adapters: { type: "string", default: "grep,agentmemory-bm25,agentmemory" },
      k: { type: "string", default: "15" },
      sweep: { type: "string", default: "5,10,20" },
      conversations: { type: "string" },
      split: { type: "string" },
      instance: { type: "string", default: "3" },
      out: { type: "string", default: "eval/reports/beam" },
    },
  });
  if (!values.data) {
    console.error("--data <dir with 100K.json, 500K.json> required (or BEAM_PATH env)");
    process.exit(2);
  }
  const [k] = positiveInts("k", values.k!);
  const sweep = positiveInts("sweep", values.sweep!);
  const ks = [k, ...sweep.filter((n) => n !== k)];
  const kMax = Math.max(...ks);
  const [instance] = positiveInts("instance", values.instance!);
  const adapterNames = values.adapters!.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of adapterNames) {
    if (!ADAPTERS[a]) {
      console.error(`unknown adapter: ${a}. options: ${Object.keys(ADAPTERS).join(",")}`);
      process.exit(2);
    }
  }

  const { questions: all, skipped } = loadBeam(join(resolve(values.data), `${values.size}.json`), values.size!);
  // Split before sampling, so the dev and holdout samples never share a question.
  const scored = selectSplit("beam", all, openSplit(values.split, "beam"), (q) => q.id, (q) => q.type);
  let conversations = byConversation(scored);
  if (values.conversations) conversations = sampleEvenly(conversations, positiveInts("conversations", values.conversations)[0]);
  const total = conversations.reduce((n, qs) => n + qs.length, 0);
  console.log(
    `BEAM ${values.size}: ${total} questions over ${conversations.length} conversations (skipped ${skipped.abstention} abstention, ${skipped.noGold} without gold), adapters: ${adapterNames.join(",")}, k=${ks.join(",")}`,
  );

  const outDir = resolve(values.out, values.size!);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = join(outDir, "scores.ndjson");
  const ingestPath = join(outDir, "ingest.ndjson");
  writeFileSync(ndjsonPath, "");
  writeFileSync(ingestPath, "");

  const rows: ScoreRow[] = [];
  for (const name of adapterNames) {
    const adapter = ADAPTERS[name];
    console.log(`\n== ${adapter.name} ==`);
    for (const qs of conversations) {
      const t0 = performance.now();
      const state = await adapter.init(qs[0].haystack, { instance, baseUrl: process.env.AGENTMEMORY_BASE_URL });
      const ingestMs = performance.now() - t0;
      try {
        for (const q of qs) {
          const t1 = performance.now();
          const result = await adapter.query(q, state, kMax);
          const latencyMs = performance.now() - t1;
          for (const n of ks) {
            const row = scoreQuestion(q, result, n, adapter.name, latencyMs);
            rows.push(row);
            appendFileSync(ndjsonPath, JSON.stringify(row) + "\n");
          }
        }
        const line = { adapter: adapter.name, conversation: qs[0].id.split("/")[1], turns: qs[0].haystack.length, questions: qs.length, ingestMs: Math.round(ingestMs) };
        appendFileSync(ingestPath, JSON.stringify(line) + "\n");
        console.log(`  ${line.conversation}: ${line.turns} turns ingested in ${(ingestMs / 1000).toFixed(1)}s, ${qs.length} questions`);
      } finally {
        if (adapter.teardown) await adapter.teardown(state);
      }
    }
  }

  const summary: Record<string, ReturnType<typeof aggregate>> = {};
  for (const n of ks) summary[`k=${n}`] = aggregate(rows.filter((r) => r.k === n));
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  for (const n of ks) {
    console.log(`\n=== k=${n} ===`);
    for (const [type, byAdapter] of Object.entries(summary[`k=${n}`].byType).sort()) {
      const cells = Object.entries(byAdapter).map(
        ([a, s]) => `${a} R=${s.recall.toFixed(3)} hit=${s.hit}/${s.n}`,
      );
      console.log(`  ${type.padEnd(26)} ${cells.join("  ")}`);
    }
  }
  console.log(`\nwrote ${ndjsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
