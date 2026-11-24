import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerEvictFunction } from "../../src/functions/evict.js";
import { KV } from "../../src/state/schema.js";
import { SearchIndex } from "../../src/state/search-index.js";
import type { CompressedObservation } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const seam = ".sort((a, b) => (a.importance ?? 5) - (b.importance ?? 5));\n          const toEvict";
const treatment = `.sort((a, b) => Number(repeated(b)) - Number(repeated(a)) || (a.importance ?? 5) - (b.importance ?? 5));
          const toEvict`;
const key = `const evidence = (o: CompressedObservation) => JSON.stringify([o.title, o.narrative, o.facts, o.files, o.concepts]);
          const latest = new Map<string, CompressedObservation>();
          for (const o of obs) {
            if (awaitingStop.has(o.id)) continue;
            const k = evidence(o);
            const prior = latest.get(k);
            if (!prior || o.timestamp > prior.timestamp) latest.set(k, o);
          }
          const repeated = (o: CompressedObservation) => latest.get(evidence(o)) !== o;
          const sorted = obs`;

async function variant(): Promise<typeof registerEvictFunction> {
  const source = await readFile("src/functions/evict.ts", "utf8");
  const declaration = "const sorted = obs";
  if (source.split(seam).length !== 2 || source.split(declaration).length !== 2) throw new Error("Project-cap seam moved");
  await mkdir("tmp/eviction-evidence", { recursive: true });
  const output = resolve("tmp/eviction-evidence/treatment.mjs");
  await build({ stdin: { contents: source.replace(seam, treatment).replace(declaration, key), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  return (await import(pathToFileURL(output).href)).registerEvictFunction;
}

const sessionId = "fixture";
const date = (day: number) => `2026-11-${day}T00:00:00.000Z`;
const cases = [
  { name: "unique", unique: "Use open inventory window 19.", repeat: "Use parcel dispatch color amber.", query: "open inventory window", wanted: ["first"], stale: [] },
  { name: "reversal", unique: "Parcel grace parcel grace parcel grace was 25 units.", repeat: "Parcel grace is now 10 units.", query: "parcel grace", wanted: ["fresh", "clone"], stale: ["first"] },
];

async function run(register: typeof registerEvictFunction, item: typeof cases[number]) {
  const kv = { ...mockKV(), writeGeneration: async () => 0 };
  const sdk = mockSdk({ looseTrigger: true });
  register(sdk as never, kv as never);
  await kv.set(KV.config, "eviction", { maxObservationsPerProject: 3, staleSessionDays: 3650, lowImportanceThreshold: 0 });
  await kv.set(KV.sessions, sessionId, { id: sessionId, project: "synthetic", observationCount: 4, startedAt: date(19) });
  await kv.set(KV.summaries, sessionId, { sessionId, coveredThrough: date(23) });
  const rows: CompressedObservation[] = [
    ["first", item.unique, 19, 4], ["clone", item.repeat, 20, 5],
    ["fresh", item.repeat, 21, 5], ["guard", "Uncovered printer settings.", 24, 1],
  ].map(([id, body, day, importance]) => ({
    id: String(id), sessionId, timestamp: date(Number(day)), title: "Fixture evidence", type: "discovery",
    narrative: String(body).padEnd(80), importance: Number(importance), facts: [], files: [], concepts: [],
  }));
  const scope = KV.observations(sessionId);
  for (const row of rows) await kv.set(scope, row.id, row);
  const { capEvictions: deleted } = await sdk.trigger("mem::evict", {}) as { capEvictions: number };
  const survivors = await kv.list<CompressedObservation>(scope);
  const index = new SearchIndex();
  for (const row of survivors) index.add(row);
  const hits = index.search(item.query);
  return {
    retained: survivors.map((row) => row.id), deleted,
    bytes: survivors.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
    answerable: hits.some((hit) => item.wanted.includes(hit.obsId)),
    staleFirst: hits[0] !== undefined && item.stale.includes(hits[0].obsId),
  };
}

export async function runExperiment() {
  const changed = await variant();
  const scenarios = [];
  for (const item of cases) scenarios.push({ name: item.name, baseline: await run(registerEvictFunction, item), treatment: await run(changed, item) });
  return { scenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
