import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { INJECT_TIMEOUT_MS } from "../../src/hooks/_missed-injection.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const cases = [
  { primaryMs: 1450, reversal: false },
  { primaryMs: 1450, reversal: true },
  { primaryMs: 2350, reversal: false },
  { primaryMs: 2350, reversal: true },
];
const amendmentMs = 240;
const skipBelowMs = 200;
const before = "Set parcel grace to 25 units.";
const after = "Set parcel grace to 10 units.";
const primaryQuery = "How do we decide parcel grace?";
const hit = (sessionId: string, timestamp: string, score: number) => ({ sessionId, score, observation: { id: `obs-${sessionId}`, narrative: "parcel grace notes", timestamp } });
const first = hit("first", "2026-11-20T00:00:00.000Z", 20);
const later = hit("later", "2026-11-21T00:00:00.000Z", 18);

async function pair(item: typeof cases[number], treatment: boolean) {
  const kv = mockKV();
  const sdk = mockSdk();
  for (const [row, decision] of [[first, before], [later, after]] as const) {
    await kv.set(KV.summaries, row.sessionId, { sessionId: row.sessionId, title: `Parcel grace ${row.sessionId}`, keyDecisions: [decision], filesModified: [], createdAt: row.observation.timestamp, coveredThrough: new Date(Date.parse(row.observation.timestamp) + 1000).toISOString() });
  }
  let elapsed = 0;
  let skipped = false;
  sdk.registerFunction("mem::search", async (data) => {
    const { query } = data as { query: string };
    if (query === primaryQuery) {
      elapsed += item.primaryMs;
      return { results: [first] };
    }
    if (treatment && INJECT_TIMEOUT_MS - elapsed < skipBelowMs) {
      skipped = true;
      return { results: [] };
    }
    elapsed += amendmentMs;
    return { results: item.reversal ? [first, later] : [first] };
  });
  registerPromptContextFunction(sdk as never, kv as never);
  const { context } = await sdk.trigger("mem::prompt-context", { sessionId: "next", project: "synthetic", prompt: primaryQuery }) as PromptContextResult;
  const selected = context.split("\n").find((line) => line === `- ${before}` || line === `- ${after}`)?.slice(2);
  if (selected === undefined) throw new Error("Fixture did not render a parcel grace decision");
  return { skipped, outcome: elapsed >= INJECT_TIMEOUT_MS ? "missed" : selected === (item.reversal ? after : before) ? "timelyCorrect" : "stale" } as const;
}

// Pre-measure rule: strictly more timely correct decisions and no increase in stale decisions.
export async function runExperiment() {
  process.env.AGENTMEMORY_PROMPT_RERANK ??= "off";
  if (process.env.AGENTMEMORY_PROMPT_RERANK !== "off") throw new Error("Run this virtual-clock fixture with the gate off");
  const arms = await Promise.all(cases.map(async (item) => [await pair(item, false), await pair(item, true)] as const));
  const score = (arm: 0 | 1) => {
    const result = { timelyCorrect: 0, stale: 0, missed: 0 };
    for (const row of arms) result[row[arm].outcome]++;
    return result;
  };
  return { baseline: score(0), treatment: score(1), skipped: arms.filter((row) => row[1].skipped).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
