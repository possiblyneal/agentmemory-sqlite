import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

type Claim = { id: string; topic: string; recorded: number; from?: number; until?: number; superseded?: number; foreign?: true };
const claims: Claim[] = [
  { id: "original", topic: "retention", recorded: 1, from: 1, until: 10, superseded: 8 },
  { id: "amended", topic: "retention", recorded: 8, from: 10, until: 26, superseded: 19 },
  { id: "scheduled", topic: "retention", recorded: 19, from: 26 },
  { id: "undated", topic: "export", recorded: 2 },
  { id: "expired", topic: "archive", recorded: 2, from: 2, until: 8 },
  { id: "resumed", topic: "archive", recorded: 12, from: 20 },
  { id: "overlap-a", topic: "transfer", recorded: 2, from: 2, until: 18 },
  { id: "overlap-b", topic: "transfer", recorded: 3, from: 3, until: 20 },
  { id: "elsewhere", topic: "billing", recorded: 2, from: 2, foreign: true },
];
const questions = [
  { name: "historical", topic: "retention", day: 9, asOf: true, expected: "original" },
  { name: "current", topic: "retention", day: 23, asOf: false, expected: "amended" },
  { name: "boundary", topic: "retention", day: 10, asOf: true, expected: "amended" },
  { name: "future", topic: "retention", day: 26, asOf: false, expected: "scheduled" },
  { name: "unknown", topic: "export", day: 23, asOf: false, expected: "missing-dates" },
  { name: "gap", topic: "archive", day: 14, asOf: true, expected: "gap" },
  { name: "overlap", topic: "transfer", day: 8, asOf: true, expected: "conflict" },
  { name: "foreign", topic: "billing", day: 23, asOf: false, expected: "no-evidence" },
];
const stamp = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString();

function effectiveAnswer(evidence: Claim[], day: number) {
  if (!evidence.length) return "no-evidence";
  if (evidence.some(row => row.from === undefined)) return "missing-dates";
  const active = evidence.filter(row => row.from! <= day && (row.until === undefined || day < row.until));
  return active.length > 1 ? "conflict" : active[0]?.id ?? "gap";
}

export async function runExperiment() {
  const pairs = [];
  for (const { name, topic, day, asOf, expected } of questions) {
    const kv = mockKV();
    const knownAt = asOf ? 23 : day;
    const evidence = claims.filter(row => row.recorded <= knownAt);
    await kv.set(KV.sessions, "local", { project: "fixture" });
    await kv.set(KV.sessions, "foreign", { project: "other" });
    for (const row of evidence) {
      const at = stamp(row.recorded);
      const fact: SemanticMemory = { id: row.id, fact: `${row.topic} ${row.id}`, confidence: 1, isLatest: row.superseded === undefined || row.superseded > knownAt,
        sourceSessionIds: [row.foreign ? "foreign" : "local"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: at, strength: 1, createdAt: at, updatedAt: at };
      await kv.set(KV.semantic, row.id, fact);
    }
    const range = asOf ? { before: Date.parse(stamp(day)) + 1 } : undefined;
    const start = performance.now();
    const [hit] = await recallSemanticFacts({ ...kv, writeGeneration: async () => 0 } as never, 1, { project: "fixture", query: topic, range });
    const baselineMs = performance.now() - start;
    const treatmentStart = performance.now();
    const treatment = effectiveAnswer(evidence.filter(row => !row.foreign && row.topic === topic), day);
    const treatmentMs = performance.now() - treatmentStart;
    pairs.push({ name, asOf, expected, baseline: hit?.fact.id ?? "no-evidence", treatment, baselineMs, treatmentMs });
  }
  return pairs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
