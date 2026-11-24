import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recordInjection } from "../../src/functions/injections.js";
import { MAX_DECISIONS, registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { cutDecision } from "../../src/functions/summarize.js";
import { KV } from "../../src/state/schema.js";
import type { InjectionRecord, SessionSummary } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const sourceId = "fixture-history";
const sessionId = "fixture-current";
const stamp = "2026-11-23T00:00:01.000Z";
const oldDecision = "Use the amber manifest.";
const newDecision = "Use the violet manifest.";
const cases = ["visible", "unchanged", "metadata", "below-cap"] as const;
const fingerprint = (decisions: string[]) => JSON.stringify(decisions.slice(0, MAX_DECISIONS).map(cutDecision));

async function run(scenario: typeof cases[number], contentAware: boolean) {
  const store = mockKV();
  const sdk = mockSdk();
  let deliveredFingerprint: string | undefined;
  const kv = {
    ...store,
    writeGeneration: async () => 0,
    list: async <T>(scope: string): Promise<T[]> => {
      const rows = await store.list<T>(scope);
      if (!contentAware || scope !== KV.injections) return rows;
      const current = await store.get<SessionSummary>(KV.summaries, sourceId);
      if (!current || !deliveredFingerprint || fingerprint(current.keyDecisions) === deliveredFingerprint) return rows;
      return rows.map((row) => {
        const record = row as InjectionRecord;
        if (record.sessionId !== sessionId) return row;
        return { ...record, injected: record.injected.filter((ref) => ref.kind !== "summary" || ref.id !== sourceId) } as T;
      });
    },
  };
  registerPromptContextFunction(sdk as never, kv as never);
  const prompt = "Select the applicable export manifest";
  sdk.registerFunction("mem::search", async (data) => ({
    results: (data as { query: string; project: string }).query === prompt && (data as { project: string }).project === "fixture" ? [{
      sessionId: sourceId,
      score: 20,
      observation: { id: "source-obs", narrative: "Export manifest was selected.", timestamp: "2026-11-23T00:00:00.000Z" },
    }] : [],
  }));
  const firstSummary = {
    sessionId: sourceId,
    title: "Manifest selection",
    createdAt: stamp,
    keyDecisions: [oldDecision, ...Array.from({ length: MAX_DECISIONS - 1 }, (_, i) => `Unrelated fixture note ${i}.`), "Original non-rendered decision."],
    filesModified: ["manifest.txt"],
  };
  const amended = [...firstSummary.keyDecisions];
  if (scenario === "visible") amended[0] = newDecision;
  if (scenario === "below-cap") amended[MAX_DECISIONS] = "Changed non-rendered decision.";
  const secondSummary = {
    ...firstSummary,
    ...(scenario === "metadata" && { title: "New metadata", filesModified: ["different.txt"] }),
    keyDecisions: amended,
  };
  async function inject(summary: typeof firstSummary) {
    await kv.set(KV.summaries, sourceId, summary);
    const result = await sdk.trigger("mem::prompt-context", { sessionId, prompt, project: "fixture" }) as PromptContextResult;
    await recordInjection(kv as never, { sessionId, source: "prompt-submit", project: "fixture", injected: result.injected, tokens: result.tokens });
    if (result.injected.some((ref) => ref.kind === "summary" && ref.id === sourceId)) deliveredFingerprint = fingerprint(summary.keyDecisions);
    return result;
  }
  const first = await inject(firstSummary);
  if (!first.context.includes(oldDecision)) throw new Error("Initial decision did not render");
  const second = await inject(secondSummary);
  const third = await inject(secondSummary);
  const choice = second.context.includes(newDecision) ? newDecision : oldDecision;
  return { stale: choice !== amended[0], secondTokens: second.tokens, thirdTokens: third.tokens };
}

export async function runExperiment() {
  const previous = process.env.AGENTMEMORY_PROMPT_RERANK;
  process.env.AGENTMEMORY_PROMPT_RERANK = "off";
  try {
    const pairs = [];
    for (const scenario of cases) pairs.push({ scenario, baseline: await run(scenario, false), treatment: await run(scenario, true) });
    return pairs;
  } finally {
    if (previous === undefined) delete process.env.AGENTMEMORY_PROMPT_RERANK;
    else process.env.AGENTMEMORY_PROMPT_RERANK = previous;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runExperiment(), null, 2));
}
