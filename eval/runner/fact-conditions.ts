import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

const stamp = "2026-11-23T00:00:00.000Z";
const fixture = [
  ["window-east", "Use a 20 minute parcel retry window when staging east.", 0.98],
  ["window-west", "Use a 45 minute parcel retry window when staging west.", 0.60],
  ["format-full", "Use an uppercase catalog output format when doing a full export.", 0.98],
  ["format-partial", "Use a lowercase catalog output format when doing a partial export.", 0.60],
  ["foreign", "Use a 5 minute parcel retry window when staging west.", 1],
] as const;
const cases = [
  { query: "parcel retry window when staging east?", wanted: "window-east" },
  { query: "parcel retry window when staging west?", wanted: "window-west" },
  { query: "catalog output format when doing a full export?", wanted: "format-full" },
  { query: "catalog output format when doing a partial export?", wanted: "format-partial" },
  { query: "parcel retry window", wanted: null },
  { query: "catalog output format", wanted: null },
  { query: "parcel retry window when staging?", wanted: null },
];

function explicitCondition(text: string) {
  return /\bwhen\s+([\p{L}\p{N} ]+)[.!?]?$/iu.exec(text.trim())?.[1]?.trim().toLowerCase();
}

export async function runExperiment() {
  const store = mockKV();
  const kv = { ...store, writeGeneration: async () => 0 };
  for (const project of ["fixture", "other"]) await kv.set(KV.sessions, project, { id: project, project });
  for (const [id, fact, confidence] of fixture) {
    const row: SemanticMemory = { id, fact, confidence, sourceSessionIds: [id === "foreign" ? "other" : "fixture"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: stamp, strength: 1, createdAt: stamp, updatedAt: stamp };
    await kv.set(KV.semantic, id, row);
  }
  const before = JSON.stringify(await kv.list(KV.semantic));
  const trials = [];
  for (const { query, wanted } of cases) {
    const ranked = await recallSemanticFacts(kv as never, fixture.length, { project: "fixture", query });
    const condition = explicitCondition(query);
    const matches = ({ fact }: typeof ranked[number]) => condition !== undefined && explicitCondition(fact.fact) === condition;
    const reordered = condition ? [...ranked.filter(matches), ...ranked.filter((item) => !matches(item))] : ranked;
    trials.push({ query, wanted, baseline: ranked.map(({ fact }) => fact.id), treatment: reordered.map(({ fact }) => fact.id) });
  }
  return { trials, storageUnchanged: JSON.stringify(await kv.list(KV.semantic)) === before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
