import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerCompressBatchFunction, parkForCompression } from "../../src/functions/compress-batch.js";
import { registerCompressFunction } from "../../src/functions/compress.js";
import { storeSyntheticCompression } from "../../src/functions/observe.js";
import { COMPRESSION_BATCH_SYSTEM } from "../../src/prompts/compression.js";
import { KV } from "../../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, RawObservation } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

async function variant(directory: string): Promise<typeof registerCompressBatchFunction> {
  let source = await readFile("src/functions/compress-batch.ts", "utf8");
  const replacements = [
    ["queued: CompressionJob[]): Promise<void>", "queued: CompressionJob[], unresolved?: CompressionJob[]): Promise<void>"],
    ["    for (const job of fallback) await compressOne(job);", `    if (unresolved) {
      unresolved.push(...fallback);
      return;
    }
    if (fallback.length >= 4) {
      const half = Math.ceil(fallback.length / 2);
      const remaining: CompressionJob[] = [];
      await compressBatch(sessionId, fallback.slice(0, half), remaining);
      await compressBatch(sessionId, fallback.slice(half), remaining);
      for (const job of remaining) await compressOne(job);
      return;
    }
    for (const job of fallback) await compressOne(job);`],
  ] as const;
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Batch seam moved: ${before}`);
    source = source.replace(before, after);
  }
  const outfile = join(directory, "treatment.mjs");
  await build({ stdin: { contents: source, resolveDir: resolve("src/functions"), loader: "ts" }, outfile, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  return (await import(pathToFileURL(outfile).href)).registerCompressBatchFunction;
}

const cases = ["recoverable", "malformed", "outage"] as const;
const sessionId = "fixture";
const ids = Array.from({ length: 6 }, (_, i) => `obs-${i}`);
const evidence = (id: string) => `Confirmed evidence for ${id}.`;
const fields = (id: string) => `<type>file_edit</type><title>Confirmed ${id}</title><facts><fact>${evidence(id)}</fact></facts><narrative>${evidence(id)} The fixture edit was verified.</narrative><importance>5</importance>`;
const block = (id: string, payload = id) => `<observation id="${id}">${fields(payload)}</observation>`;

async function run(register: typeof registerCompressBatchFunction, scenario: typeof cases[number]) {
  const store = mockKV();
  const sdk = mockSdk({ looseTrigger: true });
  const finished = new Map<string, number>();
  const writes = new Map<string, number>();
  let calls = 0;
  let misattributed = 0;
  const kv = {
    ...store,
    set: async <T>(scope: string, key: string, value: T) => {
      const row = value as Partial<CompressedObservation>;
      if (scope === KV.observations(sessionId) && row.title?.startsWith("Confirmed ")) {
        if (row.title !== `Confirmed ${key}`) misattributed++;
        if (!finished.has(key)) finished.set(key, calls);
        writes.set(key, (writes.get(key) ?? 0) + 1);
      }
      return store.set(scope, key, value);
    },
  };
  const provider: MemoryProvider = {
    name: "fixture",
    summarize: async () => "",
    compress: async (system, prompt) => {
      calls++;
      if (scenario === "outage") throw new Error("Scripted provider outage");
      if (system !== COMPRESSION_BATCH_SYSTEM) {
        const id = ids.find((candidate) => prompt.includes(`payload ${candidate}`));
        if (!id) throw new Error("Individual prompt missing its fixture token");
        return `<observation>${fields(id)}</observation>`;
      }
      const requested = [...prompt.matchAll(/=== Observation (\S+) ===/g)].map((m) => m[1]!);
      if (requested.length === ids.length) {
        return [block("obs-0"), block("obs-1"), block("obs-2"), block("obs-2", "obs-4"), block("wrong-id", "obs-3")].join("\n");
      }
      if (scenario === "recoverable") return requested.map((id) => block(id)).join("\n");
      const [first, second] = requested;
      return first === "obs-2"
        ? [block(first), block(second!), block(second!, first), block("obs-0", first)].join("\n")
        : block("wrong-id", first);
    },
  };
  registerCompressFunction(sdk as never, kv as never, provider);
  register(sdk as never, kv as never, provider);
  for (const id of ids) {
    const raw: RawObservation = {
      id, sessionId, timestamp: "2026-11-23T00:00:00.000Z", hookType: "post_tool_use", toolName: "Edit",
      toolInput: { file_path: "src/fixture.ts" }, toolOutput: `payload ${id}`, raw: {},
    };
    await parkForCompression(kv as never, raw);
    await storeSyntheticCompression(kv as never, raw, { awaitingCompression: true });
    await sdk.trigger("mem::compress-enqueue", { observationId: id, sessionId, raw });
  }
  await sdk.trigger("mem::compress-flush", { sessionId });
  const completion = ids.map((id) => finished.get(id) ?? null);
  const missing = (await Promise.all(ids.map((id) => kv.get(KV.observations(sessionId), id)))).filter((row) => row === null).length;
  const parked = (await kv.list(KV.compressPending)).length;
  const repeatWrites = [...writes.values()].reduce((extra, count) => extra + count - 1, 0);
  return { calls, completion, missing, parked, misattributed, repeatWrites };
}

export async function runExperiment() {
  await mkdir("tmp/batch-split", { recursive: true });
  const directory = await mkdtemp(resolve("tmp/batch-split/paired-"));
  try {
    const treatmentRegistrar = await variant(directory);
    const pairs = [];
    for (const scenario of cases) {
      const baseline = await run(registerCompressBatchFunction, scenario);
      const treatment = await run(treatmentRegistrar, scenario);
      const delayed = baseline.completion.filter((at, i) => at !== null && (treatment.completion[i] ?? Infinity) > at).length;
      pairs.push({ scenario, baseline, treatment, delayed });
    }
    return pairs;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runExperiment(), null, 2));
}
