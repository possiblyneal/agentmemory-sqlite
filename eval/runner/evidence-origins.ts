import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

type Evidence = { claim: "amber" | "jade"; representation: string; root?: string };
const evidence = (claim: Evidence["claim"], representation: string, root?: string): Evidence => ({ claim, representation, root });
const copy = [evidence("amber", "observation", "report-a"), evidence("amber", "summary", "report-a"), evidence("amber", "insight", "report-a")];
const independent = [evidence("jade", "fixture", "fixture-b"), evidence("jade", "review", "review-c")];
const cases = [
  { name: "copied-error", rows: [...copy, ...independent] },
  { name: "corroborated", rows: [...copy.slice(0, 1), ...independent] },
  { name: "incomplete", rows: [...copy.slice(0, 1), evidence("jade", "fixture"), evidence("jade", "review")] },
];

function choose(rows: Evidence[], byOrigin: boolean) {
  const support = new Map<Evidence["claim"], Set<string>>();
  for (const [index, row] of rows.entries()) {
    const key = byOrigin ? row.root : String(index);
    if (key === undefined) continue;
    const units = support.get(row.claim) ?? new Set<string>();
    units.add(key);
    support.set(row.claim, units);
  }
  const [first, second] = [...support.entries()].sort((a, b) => b[1].size - a[1].size);
  return first && first[1].size !== second?.[1].size ? first[0] : "defer";
}

export async function runExperiment() {
  const results = [];
  for (const { name, rows } of cases) {
    const kv = mockKV();
    const at = "2026-11-24T00:00:00Z";
    await kv.set(KV.sessions, "fixture", { project: "fixture" });
    for (const [index, row] of rows.entries()) {
      const id = String(index);
      const fact: SemanticMemory = { id, fact: `Catalog ${row.representation}: ${row.claim}`, confidence: 1, sourceSessionIds: ["fixture"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: at, strength: 1, createdAt: at, updatedAt: at };
      await kv.set(KV.semantic, id, fact);
    }
    const hits = await recallSemanticFacts({ ...kv, writeGeneration: async () => 0 } as never, rows.length, { project: "fixture", query: "catalog" });
    const delivered = hits.map(({ fact }) => rows[Number(fact.id)]);
    results.push({ name, expected: "jade", baseline: choose(delivered, false), treatment: choose(delivered, true), unknown: delivered.filter(row => row.root === undefined).length });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
