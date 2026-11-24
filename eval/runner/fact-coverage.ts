import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recallSemanticFacts } from "../../src/functions/semantic-recall.js";
import { KV } from "../../src/state/schema.js";
import type { SemanticMemory } from "../../src/types.js";
import { mockKV } from "../../test/helpers/mocks.js";

const stamp = "2026-11-23T00:00:00.000Z";
type Row = { id: string; text: string; confidence: number; foreign?: boolean };
type Case = { id: string; query: string; rows: Row[]; correct: string[]; control?: boolean };
const cases: Case[] = [
  { id: "specific", query: "parcel retry west", correct: ["specific"], rows: [
    { id: "broad", text: "Parcel retry defaults to twenty minutes", confidence: 1 },
    { id: "specific", text: "Parcel retry west uses forty minutes", confidence: 0.6 },
  ] },
  { id: "risk", query: "catalog export encrypted", correct: ["safe"], rows: [
    { id: "safe", text: "Catalog export uses encryption", confidence: 1 },
    { id: "wrong", text: "Catalog export encrypted backups are disabled", confidence: 0.6 },
  ] },
  { id: "ambiguous", query: "parcel retry", correct: ["broad"], control: true, rows: [
    { id: "broad", text: "Parcel retry defaults to twenty minutes", confidence: 1 },
    { id: "specific", text: "Parcel retry west uses forty minutes", confidence: 0.6 },
  ] },
  { id: "no-match", query: "nebula quasar", correct: [], control: true, rows: [
    { id: "local", text: "Parcel retry defaults to twenty minutes", confidence: 1 },
  ] },
  { id: "scope", query: "parcel retry west", correct: ["local"], control: true, rows: [
    { id: "foreign", text: "Parcel retry west uses five minutes", confidence: 1, foreign: true },
    { id: "local", text: "Parcel retry west uses forty minutes", confidence: 0.7 },
  ] },
];

async function variant(directory: string): Promise<typeof recallSemanticFacts> {
  let source = await readFile("src/functions/semantic-recall.ts", "utf8");
  for (const [before, after] of [
    ["(fact.confidence * count) / terms.length", "count + fact.confidence / 2"],
    ["(fact.confidence * bestCount) / terms.length", "bestCount + fact.confidence / 2"],
  ]) {
    if (source.split(before!).length !== 2) throw new Error(`Scoring seam moved: ${before}`);
    source = source.replace(before!, after!);
  }
  const outfile = join(directory, "treatment.mjs");
  await build({ stdin: { contents: source, resolveDir: resolve("src/functions"), loader: "ts" }, outfile, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  return (await import(pathToFileURL(outfile).href)).recallSemanticFacts;
}

export async function runExperiment() {
  await mkdir("tmp/fact-coverage", { recursive: true });
  const directory = await mkdtemp(resolve("tmp/fact-coverage/paired-"));
  try {
    const treatment = await variant(directory);
    const pairs = [];
    for (const fixture of cases) {
      const store = mockKV();
      const kv = { ...store, writeGeneration: async () => 0 };
      for (const project of ["fixture", "other"]) await kv.set(KV.sessions, project, { id: project, project });
      for (const row of fixture.rows) {
        const fact: SemanticMemory = { id: row.id, fact: row.text, confidence: row.confidence, sourceSessionIds: [row.foreign ? "other" : "fixture"], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: stamp, strength: 1, createdAt: stamp, updatedAt: stamp };
        await kv.set(KV.semantic, row.id, fact);
      }
      const options = { query: fixture.query, project: "fixture" };
      const baseline = (await recallSemanticFacts(kv as never, 1, options))[0]?.fact.id ?? null;
      const candidate = (await treatment(kv as never, 1, options))[0]?.fact.id ?? null;
      pairs.push({ id: fixture.id, baseline, treatment: candidate, correct: fixture.correct, control: fixture.control ?? false });
    }
    return pairs;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
