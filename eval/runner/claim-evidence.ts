import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { fetchWithTimeout } from "../../src/providers/_fetch.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";
import { appendDurable, startNdjson } from "./durable.js";
import { scoreAction } from "./outcome-ranking.js";

type Claim = { text: string; status: "current" | "superseded" | "uncertain"; id: string };
const cases = [
  { name: "reversal", claims: [
    { text: "Set palette mint.", status: "superseded", id: "turn-a", source: "The first approved palette was mint." },
    { text: "Set palette iris.", status: "current", id: "turn-b", source: "The final approval replaced mint with iris." },
  ], expected: "iris", unsafe: ["mint"] },
  { name: "uncertain", claims: [
    { text: "Set palette jade.", status: "uncertain", id: "turn-c", source: "We discussed jade but never approved it." },
  ], expected: "defer", unsafe: ["jade"] },
  { name: "missing", claims: [
    { text: "Set palette sage.", status: "uncertain", id: "turn-d", source: null },
  ], expected: "defer", unsafe: ["sage"] },
  { name: "valid", claims: [
    { text: "Set palette rose.", status: "current", id: "turn-e", source: "The user approved rose as the palette." },
  ], expected: "rose", unsafe: [] },
] as const;
const prompt = "Which palette should I set?";
const timestamp = "2026-11-23T00:00:00Z";

export async function attachEvidence(summary: string, claims: readonly Claim[], lookup: (id: string) => Promise<string | null>) {
  for (const { text, status, id } of claims) {
    const line = `- ${text}`;
    if (!summary.split("\n").includes(line)) throw new Error("Claim is not a visible Summary line");
    const source = await lookup(id);
    const evidence = source === null ? `source unavailable (${id})` : `source ${id}: ${source}`;
    summary = summary.split("\n").map((item) => item === line ? `${line} [${status}; ${evidence}]` : item).join("\n");
  }
  return summary;
}

export function scoreClaimAction(reply: string, expected: string, unsafe: readonly string[]) {
  return { correct: scoreAction(reply, expected, expected).success, unsafe: unsafe.some((value) => scoreAction(reply, expected, value).stale) };
}

async function contextFor(item: typeof cases[number]) {
  const kv = mockKV();
  const sdk = mockSdk();
  registerPromptContextFunction(sdk as never, { ...kv, writeGeneration: async () => 0 } as never);
  sdk.registerFunction("mem::search", async (data) => {
    const query = data as { query: string; project: string };
    return { results: query.query === prompt && query.project === "fixture" ? [{ sessionId: "past", score: 20, observation: { id: "hit", narrative: "Palette work", timestamp } }] : [] };
  });
  await kv.set(KV.summaries, "past", { sessionId: "past", title: "Palette work", keyDecisions: item.claims.map((claim) => claim.text), filesModified: [], createdAt: timestamp });
  for (const claim of item.claims) {
    if (claim.source !== null) await kv.set(KV.observations("past"), claim.id, { narrative: claim.source });
  }
  const result = await sdk.trigger("mem::prompt-context", { sessionId: "current", project: "fixture", prompt }) as PromptContextResult;
  if (result.injected.length !== 1 || result.injected[0]?.kind !== "summary") throw new Error("Expected one rendered Summary");
  let lookups = 0;
  const start = performance.now();
  const treatment = await attachEvidence(result.context, item.claims, async (id) => {
    lookups++;
    return (await kv.get<{ narrative: string }>(KV.observations("past"), id))?.narrative ?? null;
  });
  return { baseline: result.context, treatment, lookups, lookupMs: performance.now() - start };
}

type Trial = ReturnType<typeof scoreClaimAction> & { revision: string; hash: string; name: string; arm: string; reply: string; promptTokens: number; modelMs: number; lookups: number; lookupMs: number };
async function run() {
  process.env.AGENTMEMORY_PROMPT_RERANK = "off";
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL("./outcome-ranking.ts", import.meta.url))).digest("hex");
  mkdirSync("tmp/claim-evidence", { recursive: true });
  const output = "tmp/claim-evidence/trials.ndjson";
  const rows = startNdjson<Trial>(output, process.argv.includes("--resume"));
  if (rows.some((row) => row.revision !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
  for (const [i, item] of cases.entries()) {
    const contexts = await contextFor(item);
    const arms = ["baseline", "treatment"] as const;
    for (const arm of (i % 2 ? [...arms].reverse() : arms)) {
      if (rows.some((row) => row.name === item.name && row.arm === arm)) continue;
      const start = performance.now();
      const response = await fetchWithTimeout("http://ai.lan:4010/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "general-eval-b", temperature: 0, seed: 42, max_tokens: 2048, stream: false,
          messages: [{ role: "user", content: `${prompt} Use recalled requirements. If provided, respect the validity labels. When no approved choice is supported, defer. Return only {"value":"<palette or defer>"}.\n\n${contexts[arm]}` }] }),
      }, 60_000);
      if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
      const body = await response.json() as { choices: { message: { content: string | null } }[]; usage: { prompt_tokens: number } };
      const reply = body.choices[0]?.message.content ?? "";
      const result = { name: item.name, arm, ...scoreClaimAction(reply, item.expected, item.unsafe), promptTokens: body.usage.prompt_tokens,
        lookups: arm === "treatment" ? contexts.lookups : 0, lookupMs: arm === "treatment" ? contexts.lookupMs : 0, modelMs: Math.round(performance.now() - start) };
      appendDurable(output, { revision, hash, reply, ...result });
      console.log(JSON.stringify(result));
    }
  }
  console.log("DONE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
