import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

type Fix = "wrap" | "stack";
const history: { id: Fix; condition: string; text: string; confidence: number }[] = [
  { id: "wrap", condition: "locked-width", text: "Layout overflow: wrap failed with locked width.", confidence: 1 },
  { id: "stack", condition: "fixed-height", text: "Layout overflow: stack clipped inside fixed height.", confidence: 0.8 },
];
const cases: { name: string; condition: string | undefined; initial: Fix; expected: Fix }[] = [
  { name: "persists", condition: "fixed-height", initial: "stack", expected: "wrap" },
  { name: "changed", condition: "fluid", initial: "wrap", expected: "wrap" },
  { name: "known-match", condition: "locked-width", initial: "wrap", expected: "stack" },
  { name: "missing", condition: undefined, initial: "wrap", expected: "stack" },
];
function action(initial: Fix, warning: string | undefined): Fix {
  return initial !== warning ? initial : initial === "wrap" ? "stack" : "wrap";
}

export async function runExperiment() {
  const kv = mockKV();
  const at = "2026-11-24T00:00:00Z";
  await kv.set(KV.sessions, "prior", { project: "fixture" });
  for (const row of history) {
    const fact: SemanticMemory = { id: row.id, fact: row.text, confidence: row.confidence, sourceSessionIds: ["prior"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: at, strength: 1, createdAt: at, updatedAt: at };
    await kv.set(KV.semantic, row.id, fact);
  }
  const hits = await recallSemanticFacts({ ...kv, writeGeneration: async () => 0 } as never, 2, { project: "fixture", query: "layout overflow" });
  return cases.map(({ name, condition, initial, expected }) => ({ name, expected,
    baseline: action(initial, hits[0]?.fact.id),
    treatment: action(initial, hits.find(({ fact }) => history.some(row => row.id === fact.id && row.condition === condition))?.fact.id),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
