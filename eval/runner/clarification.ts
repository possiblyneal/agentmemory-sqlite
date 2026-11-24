import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

type Choice = "old" | "new";
type Evidence = { id: string; value: Choice; supersedes?: string; foreign?: true };
const conflict: Evidence[] = [{ id: "a", value: "old" }, { id: "b", value: "new" }];
const cases: { name: string; choices: Evidence[]; answer: Choice; consequential: boolean; rework: number }[] = [
  { name: "costly-error", choices: conflict, answer: "new", consequential: true, rework: 12 },
  { name: "costly-lucky", choices: conflict, answer: "old", consequential: true, rework: 12 },
  { name: "amended", choices: [conflict[0], { ...conflict[1], supersedes: "a" }], answer: "new", consequential: true, rework: 12 },
  { name: "low-stakes", choices: conflict, answer: "new", consequential: false, rework: 2 },
  { name: "single-scoped", choices: [conflict[0], { ...conflict[1], foreign: true }], answer: "old", consequential: true, rework: 12 },
  { name: "agreement", choices: [conflict[0], { id: "c", value: "old" }], answer: "old", consequential: true, rework: 12 },
];
const INTERRUPTION = 2;

export async function runExperiment() {
  const rows = [];
  for (const { name, choices, answer, consequential, rework } of cases) {
    const kv = mockKV();
    const at = "2026-11-24T00:00:00Z";
    await kv.set(KV.sessions, "fixture", { project: "fixture" });
    await kv.set(KV.sessions, "foreign", { project: "foreign" });
    for (const [index, item] of choices.entries()) {
      const fact: SemanticMemory = { id: item.id, fact: `Catalog choice ${item.id}: ${item.value}`, confidence: 1 - index / 4,
        sourceSessionIds: [item.foreign ? "foreign" : "fixture"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: at, strength: 1, createdAt: at, updatedAt: at };
      await kv.set(KV.semantic, item.id, fact);
    }
    const hits = await recallSemanticFacts({ ...kv, writeGeneration: async () => 0 } as never, 2, { project: "fixture", query: "catalog choice" });
    const evidence = hits.map(({ fact }) => choices.find(item => item.id === fact.id)!);
    const replaced = new Set(evidence.flatMap(item => item.supersedes === undefined ? [] : [item.supersedes]));
    const candidates = [...new Set(evidence.filter(item => !replaced.has(item.id)).map(item => item.value))];
    const baseline = candidates[0];
    const asked = consequential && candidates.length === 2;
    const treatment = asked ? answer : baseline;
    rows.push({ name, answer, baseline, treatment, asked, resolvedByEvidence: candidates.length === 1,
      baselineTime: baseline === answer ? 0 : rework,
      treatmentTime: (treatment === answer ? 0 : rework) + (asked ? INTERRUPTION : 0) });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
