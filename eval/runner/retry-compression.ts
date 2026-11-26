import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { registerCompressFunction } from "../../src/functions/compress.js";
import { parkForCompression, registerCompressBatchFunction } from "../../src/functions/compress-batch.js";
import { storeSyntheticCompression } from "../../src/functions/observe.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { KV } from "../../src/state/schema.js";
import type { CompressedObservation, RawObservation } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";
import { appendDurable, startNdjson } from "./durable.js";

const cases = [
  { name: "catalog", fix: "winter-indigo", verification: "41", passed: "Catalog validation passed all 41 checks.", noise: "" },
  { name: "parcel", fix: "dispatch-amber", verification: "7319", passed: "Critical verification result: emitted artifact checksum 7319. Record that exact checksum.", noise: "Trace: scanned fixture, status normal.\n".repeat(45) },
];
const arms = ["baseline", "synthetic"] as const;

async function run(item: typeof cases[number], arm: typeof arms[number], model: OpenAIProvider) {
  const sdk = mockSdk({ looseTrigger: true }) as never;
  const store = mockKV();
  const kv = store as never;
  const calls: { ms: number; reply?: string; failed?: boolean }[] = [];
  const provider = { compress: async (system: string, prompt: string) => {
    const start = performance.now();
    try {
      const reply = await model.compress(system, prompt);
      calls.push({ ms: Math.round(performance.now() - start), reply });
      return reply;
    } catch (error) {
      calls.push({ ms: Math.round(performance.now() - start), failed: true });
      throw error;
    }
  } } as never;
  registerCompressFunction(sdk, kv, provider);
  registerCompressBatchFunction(sdk, kv, provider);
  const dispatch = sdk as ReturnType<typeof mockSdk>;
  const sessionId = `${item.name}-${arm}`;
  const command = { command: "npm run validate", cwd: `/fixture/${item.name}` };
  const steps = [
    { hookType: "post_tool_failure", toolName: "Bash", toolInput: command, toolOutput: "Validation failed: configured fixture profile does not exist." },
    { hookType: "post_tool_use", toolName: "Edit", toolInput: { file_path: "settings.ini", old_string: "profile=archived", new_string: `profile=${item.fix}` }, toolOutput: `Changed validation profile to ${item.fix}.` },
    { hookType: "post_tool_use", toolName: "Bash", toolInput: command, toolOutput: `${item.noise}${item.passed}\n${item.noise}Process exited successfully.` },
  ];
  for (const [i, step] of steps.entries()) {
    const raw: RawObservation = { ...step, raw: step, id: `obs-${i}`, sessionId, timestamp: `2026-11-23T00:00:0${i}.000Z` };
    const synthetic = i === 2 && arm === "synthetic";
    if (!synthetic) await parkForCompression(kv, raw);
    await storeSyntheticCompression(kv, raw, { awaitingCompression: !synthetic });
    if (!synthetic) await dispatch.trigger("mem::compress-enqueue", { observationId: raw.id, sessionId, raw });
  }
  await dispatch.trigger("mem::compress-flush", { sessionId });
  const rows = await Promise.all(steps.map((_, i) => store.get<CompressedObservation>(KV.observations(sessionId), `obs-${i}`)));
  const pending = await store.list(KV.compressPending);
  if (rows.some((row) => !row || row.awaitingCompression) || pending.length || calls.some((call) => call.failed)) {
    throw new Error(`Incomplete Compression: ${item.name}/${arm}`);
  }
  const text = rows.map((row) => [row!.title, row!.narrative, ...row!.facts].join(" ").toLowerCase());
  return { calls, records: text, fix: text[1]!.includes(item.fix), verification: new RegExp(`\\b${item.verification}\\b`).test(text[2]!), ms: calls.reduce((sum, call) => sum + call.ms, 0) };
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
mkdirSync("tmp/retry-compression", { recursive: true });
const output = "tmp/retry-compression/trials.ndjson";
const rows = startNdjson<Awaited<ReturnType<typeof run>> & { revision: string; hash: string; name: string; arm: string }>(output, process.argv.includes("--resume"));
if (rows.some((row) => row.revision !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
process.env.OPENAI_EXTRA_BODY = JSON.stringify({ temperature: 0, seed: 42 });
const provider = new OpenAIProvider("local", "general-eval-b", 2048, "http://ai.lan:4010/v1");
for (const [i, item] of cases.entries()) {
  for (const arm of i % 2 === 0 ? arms : [...arms].reverse()) {
    if (rows.some((row) => row.name === item.name && row.arm === arm)) continue;
    const result = await run(item, arm, provider);
    appendDurable(output, { revision, hash, name: item.name, arm, ...result });
    console.log(`${item.name} ${arm}: fix=${result.fix} verification=${result.verification} calls=${result.calls.length} ms=${result.ms}`);
  }
}
