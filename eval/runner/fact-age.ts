import { build } from "esbuild";
import { deepStrictEqual } from "node:assert";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

type Row = { id: string; text: string; confidence: number; age: "old" | "fresh"; validity: "valid" | "stale"; durability: "durable" | "time-sensitive"; foreign?: boolean };
type Case = { id: string; limit: number; rows: Row[]; query?: string };
const durable: Row = { id: "durable", text: "Parcel configuration always requires encryption", confidence: 1, age: "old", validity: "valid", durability: "durable" };
const fresh: Row = { id: "fresh", text: "Parcel rollout currently targets Monday", confidence: 0.8, age: "fresh", validity: "valid", durability: "time-sensitive" };
const cases: Case[] = [
  { id: "durable", limit: 1, rows: [durable, fresh] },
  { id: "reorder", limit: 2, rows: [durable, fresh] },
  { id: "stale", limit: 1, rows: [
    { id: "stale", text: "Deployment currently targets Tuesday", confidence: 1, age: "old", validity: "stale", durability: "time-sensitive" },
    { id: "current", text: "Deployment currently targets Friday", confidence: 0.8, age: "fresh", validity: "valid", durability: "time-sensitive" },
  ] },
  { id: "query", limit: 2, rows: [durable, fresh], query: "parcel" },
  { id: "scope", limit: 1, rows: [
    { ...durable, id: "foreign", foreign: true },
    { ...fresh, id: "local" },
  ] },
];

async function variant(directory: string): Promise<typeof recallSemanticFacts> {
  let source = await readFile("src/functions/semantic-recall.ts", "utf8");
  const before = "fact.confidence / (1 + days * DAILY_RECENCY_DECAY)";
  if (source.split(before).length !== 2) throw new Error("Queryless scoring seam moved");
  source = source.replace(before, "fact.confidence");
  const outfile = join(directory, "treatment.mjs");
  await build({ stdin: { contents: source, resolveDir: resolve("src/functions"), loader: "ts" }, outfile, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  return (await import(pathToFileURL(outfile).href)).recallSemanticFacts;
}

export async function runExperiment() {
  await mkdir("tmp/fact-age", { recursive: true });
  const directory = await mkdtemp(resolve("tmp/fact-age/paired-"));
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-11-23T00:00:00.000Z");
  try {
    const treatment = await variant(directory);
    const pairs = [];
    for (const fixture of cases) {
      const store = mockKV();
      const kv = { ...store, writeGeneration: async () => 0 };
      for (const project of ["fixture", "other"]) await kv.set(KV.sessions, project, { id: project, project });
      for (const row of fixture.rows) {
        const stamp = row.age === "old" ? "2026-08-15T00:00:00.000Z" : "2026-11-23T00:00:00.000Z";
        const fact: SemanticMemory = { id: row.id, fact: row.text, confidence: row.confidence, sourceSessionIds: [row.foreign ? "other" : "fixture"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: stamp, strength: 1, createdAt: stamp, updatedAt: stamp };
        await kv.set(KV.semantic, row.id, fact);
      }
      const options = { query: fixture.query, project: "fixture" };
      const before = await Promise.all(fixture.rows.map(row => kv.get(KV.semantic, row.id)));
      const baseline = await recallSemanticFacts(kv as never, fixture.limit, options);
      const candidate = await treatment(kv as never, fixture.limit, options);
      if (fixture.query) deepStrictEqual(candidate, baseline);
      deepStrictEqual(await Promise.all(fixture.rows.map(row => kv.get(KV.semantic, row.id))), before);
      pairs.push({ id: fixture.id, baseline: baseline.map(hit => hit.fact.id), treatment: candidate.map(hit => hit.fact.id) });
    }
    return pairs;
  } finally {
    Date.now = originalNow;
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
