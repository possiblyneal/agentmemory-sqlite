import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { registerContextFunction } from "../../src/functions/context.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { KV } from "../../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, SessionSummary } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";
import { appendDurable, startNdjson } from "./durable.js";
import { screenOnePass } from "./fold-drift-core.js";

// Screen: at least one valid omission newly visible, zero losses and zero unsupported additions.
// Every key item is needed at the first SessionStart following this completed Session.
const cases = [
  { id: "publishing", turns: [
    "Publish the catalog as a single Markdown file.",
    "Use teal for the cover; perhaps remove captions later, but do not change them now.",
    "One exception: keep the original page numbers in imported catalogs, even when the page order changes.",
  ], key: ["Single Markdown file", "Teal cover", "Do not change captions now", "Keep original imported page numbers even if reordered"] },
  { id: "warehouse", turns: [
    "Set the archive retention to 45 days.",
    "Correction: use 60 days, not 45.",
    "Do not export aisle labels unless the export is for inventory reconciliation.",
  ], key: ["60-day archive retention, superseding 45", "Export aisle labels only for inventory reconciliation"] },
  { id: "exploration", turns: [
    "Could you compare the paper stock options?",
    "I liked linen in the mockup, but don't select a stock yet.",
    "No change to the production print job while we compare options.",
  ], key: ["Do not select a stock yet", "No production print changes while comparing"] },
  { id: "short-control", turns: ["Keep two decimal places in invoice totals."], key: ["Two decimal places in invoice totals"] },
];
const noise = ["Opened the example output", "Listed the fixture folder", "Read the first fixture", "Compared the sample layouts", "Checked line endings", "Listed the modified files"];
const budget = 2000;
const profile = "general-eval-b";
const timestamp = "2026-11-23T00:00:00.000Z";
const project = "synthetic-second-read";
const system = `Find durable decisions the Operator actually made that are missing from the draft. Use only the chronological Operator statements. A suggestion is not a decision; a correction replaces the old decision. Preserve exact values, exceptions, time limits and negation. Do not rewrite or repeat anything already in the draft. Reply with only a JSON array of {"decision":"one complete decision","quote":"exact contiguous quote from one Operator statement"}. Return [] if nothing is missing.`;

async function context(summary: SessionSummary) {
  const kv = mockKV();
  const sdk = mockSdk();
  registerContextFunction(sdk as never, kv as never, budget);
  await kv.set(KV.sessions, summary.sessionId, { id: summary.sessionId, startedAt: timestamp, status: "completed", project });
  await kv.set(KV.summaries, summary.sessionId, summary);
  const result = await sdk.trigger("mem::context", { sessionId: "next", project, budget }) as { context: string };
  if (!result.context.includes(summary.title)) throw new Error(`Summary not rendered: ${summary.sessionId}`);
  return result.context;
}

function additions(reply: string, turns: string[]) {
  const value: unknown = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!Array.isArray(value)) throw new Error("Second read did not return a JSON array");
  const decisions: string[] = [];
  const rejected: unknown[] = [];
  for (const item of value) {
    if (typeof item?.decision === "string" && item.decision.trim() && typeof item.quote === "string" && item.quote.trim() && turns.some((turn) => turn.includes(item.quote))) {
      decisions.push(item.decision.trim());
    } else {
      rejected.push(item);
    }
  }
  return { decisions, rejected };
}

async function pair(provider: OpenAIProvider, item: typeof cases[number]) {
  const rows = item.id === "short-control" ? item.turns : [...item.turns, ...noise];
  const observations = rows.map((text, index): CompressedObservation => ({
    id: `${item.id}-${index}`, sessionId: item.id, timestamp: new Date(Date.parse(timestamp) + index * 1000).toISOString(),
    type: "discovery", title: index < item.turns.length ? "Operator statement" : "Agent activity", narrative: text, facts: [], files: [], concepts: [], importance: 5,
  }));
  const seen = new Set<string>();
  let baselineCalls = 0;
  const instrumented: MemoryProvider = {
    name: provider.name,
    compress: provider.compress.bind(provider),
    summarize: (system, prompt) => {
      baselineCalls++;
      for (const turn of item.turns) if (prompt.includes(turn)) seen.add(turn);
      return provider.summarize(system, prompt);
    },
  };
  const started = performance.now();
  const { fullSummary: draft, full } = await screenOnePass(instrumented, observations, { sessionId: item.id, project, batch: observations.length });
  const baselineMs = Math.round(performance.now() - started);
  if (!draft || seen.size !== item.turns.length) throw new Error(`Missing baseline Summary or input evidence: ${item.id}`);
  const eligible = observations.length >= 8 && full <= 3;
  const baseline = await context(draft);
  let secondMs = 0;
  let reply: string | undefined;
  let error: string | undefined;
  let proposed: ReturnType<typeof additions> = { decisions: [], rejected: [] };
  if (eligible) {
    const started = performance.now();
    try {
      reply = await provider.summarize(system, JSON.stringify({ draft, operatorStatements: item.turns }));
      proposed = additions(reply, item.turns);
    } catch (cause) {
      error = cause instanceof SyntaxError ? "Invalid JSON" : String(cause);
    }
    secondMs = Math.round(performance.now() - started);
  }
  const treatment = await context({ ...draft, keyDecisions: [...draft.keyDecisions, ...new Set(proposed.decisions.filter((decision) => !draft.keyDecisions.includes(decision)))] });
  return { id: item.id, key: item.key, observations: observations.length, draftCount: full, eligible, baselineCalls, baselineMs, secondMs, baseline, treatment, reply, proposed, error };
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const runnerHash = createHash("sha256").update(await import("node:fs/promises").then(({ readFile }) => readFile(new URL(import.meta.url)))).digest("hex");
const dir = resolve("tmp/decision-second-read");
mkdirSync(dir, { recursive: true });
const path = resolve(dir, "pairs.ndjson");
const rows = startNdjson<{ revision: string; runnerHash: string; id: string }>(path, process.argv.includes("--resume"));
if (rows.some((row) => row.revision !== revision || row.runnerHash !== runnerHash)) throw new Error("Saved pairs use a different revision or runner");
process.env.OPENAI_EXTRA_BODY = JSON.stringify({ temperature: 0, seed: 42 });
const provider = new OpenAIProvider("local", profile, 2048, "http://ai.lan:4010/v1");
for (const item of cases) {
  if (rows.some((row) => row.id === item.id)) continue;
  const result = await pair(provider, item);
  appendDurable(path, { revision, runnerHash, ...result });
  console.log(`${item.id}: draft=${result.draftCount} eligible=${result.eligible} secondMs=${result.secondMs} error=${result.error ?? "none"}`);
}
console.log("DONE");
