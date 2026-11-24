import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";
import { appendDurable, startNdjson } from "./durable.js";

const cases = [
  { name: "catalog", note: "Render headings in uppercase.", rule: "Keep all headings ASCII.", task: "For the new catalog, use the template's default title case unless a requirement overrides it.", field: "heading", allowed: ["Winter Catalog", "WINTER CATALOG", "Wintér Catalog"], wanted: 0, overapplied: 1, violates: 2 },
  { name: "parcel", note: "Round parcel weights to the nearest integer.", rule: "Record weights in kilograms, never pounds.", task: "Record 1.25 kilograms and preserve the input precision unless a requirement overrides it.", field: "weight", allowed: ["1 kg", "1.25 lb", "1.25 kg"], wanted: 2, overapplied: 0, violates: 1 },
  { name: "archive", note: "Keep demonstration reports for seven days.", rule: "Never retain an archive fixture for more than 30 days.", task: "Use the standard 14-day retention for this regular report unless a requirement overrides it.", field: "retention", allowed: ["60 days", "14 days", "7 days"], wanted: 1, overapplied: 2, violates: 0 },
  { name: "release", note: "List the implementation note before the verification result.", rule: "Include the recorded verification result in the handoff.", task: "Use today's template: verification first, then implementation, unless a requirement overrides it.", field: "handoff", allowed: ["implementation only", "implementation then verification", "verification then implementation"], wanted: 2, overapplied: 1, violates: 0 },
];
const arms = ["baseline", "labeled"] as const;
const stamp = "2026-11-23T00:00:00.000Z";
const system = "Choose one value for the requested field. Follow genuine Operator requirements and the new task. Return only JSON with the zero-based choice index: {\"choice\":0}.";

async function render(item: typeof cases[number]) {
  const sdk = mockSdk();
  const kv = { ...mockKV(), writeGeneration: async () => 0 };
  registerPromptContextFunction(sdk as never, kv as never);
  await kv.set(KV.summaries, "old", { sessionId: "old", title: `${item.name} fixture`, keyDecisions: [item.note, item.rule], createdAt: stamp, filesModified: [] });
  sdk.registerFunction("mem::search", async (payload) => ({ results: (payload as { query: string }).query === item.task
    ? [{ sessionId: "old", score: 20, observation: { id: "obs", timestamp: stamp, narrative: `${item.name} decisions` } }]
    : [] }));
  const { context } = await sdk.trigger("mem::prompt-context", { sessionId: "new", project: "fixture", prompt: item.task }) as PromptContextResult;
  if (!context.includes(`- ${item.note}\n- ${item.rule}`)) throw new Error("Expected both notes in production order");
  return context;
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
mkdirSync("tmp/instruction-labels", { recursive: true });
const output = "tmp/instruction-labels/trials.ndjson";
const rows = startNdjson<{ revision: string; hash: string; name: string; arm: string }>(output, process.argv.includes("--resume"));
if (rows.some((row) => row.revision !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
process.env.AGENTMEMORY_PROMPT_RERANK = "off";
process.env.OPENAI_EXTRA_BODY = JSON.stringify({ temperature: 0, seed: 42 });
const provider = new OpenAIProvider("local", "general-eval-b", 2048, "http://ai.lan:4010/v1");

for (const [i, item] of cases.entries()) {
  const baseline = await render(item);
  const labeled = baseline
    .replace(/^Requirements the user settled in past Sessions of this project\..*$/m, "Past Session decisions. Apply Operator instructions as requirements; implementation notes describe prior work.")
    .replace(`- ${item.note}\n- ${item.rule}`, `- [Implementation note] ${item.note}\n- [Operator instruction] ${item.rule}`);
  if (labeled.includes("They still hold:") || !labeled.includes("[Operator instruction]")) throw new Error("Expected the annotated Summary block");
  for (const arm of i % 2 === 0 ? arms : [...arms].reverse()) {
    if (rows.some((row) => row.name === item.name && row.arm === arm)) continue;
    const context = arm === "baseline" ? baseline : labeled;
    const prompt = `${context}\n\nUser: ${item.task}\nField: ${item.field}\n${item.allowed.map((value, index) => `${index}. ${value}`).join("\n")}`;
    const reply = await provider.summarize(system, prompt);
    let choice: unknown;
    try { choice = (JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { choice?: unknown } | null)?.choice; }
    catch { /* Invalid choices do not count as correct. */ }
    const record = { name: item.name, arm, valid: choice === 0 || choice === 1 || choice === 2, correct: choice === item.wanted, overapplied: choice === item.overapplied, violation: choice === item.violates };
    appendDurable(output, { revision, hash, ...record, choice, reply });
    console.log(JSON.stringify(record));
  }
}
console.log("DONE");
