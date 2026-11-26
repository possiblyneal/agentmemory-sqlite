import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recordInjection } from "../../src/functions/injections.js";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { registerSummarizeFunction, summaryCovers } from "../../src/functions/summarize.js";
import { KV } from "../../src/state/schema.js";
import type { InjectionRecord, SessionSummary } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const sourceId = "fixture-source";
const prompt = "Which export manifest applies now";
const evidence = "Retained source evidence (not a verified requirement): ";
const decided = "Use the violet manifest.";
const proposal = "Consider using the amber manifest.";
const stamp = (i: number) => new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
const scenarios = ["seen-correct", "seen-stale", "unseen"] as const;

async function run(scenario: typeof scenarios[number], bounded: boolean) {
  const store = mockKV();
  const sdk = mockSdk();
  let recovered = false;
  let rejected = 0;
  const observations = Array.from({ length: 6 }, (_, i) => ({
    id: `obs-${i}`, sessionId: sourceId, timestamp: stamp(i), title: `marker-${i}`,
    narrative: i === 2 ? proposal : i === 3 ? decided : `Unrelated fixture work ${i}.`,
    facts: [], files: [], concepts: [], type: "conversation", importance: 5,
  }));
  const hit = observations[scenario === "seen-stale" ? 2 : 3]!;
  async function uncovered() {
    const summary = await store.get<SessionSummary>(KV.summaries, sourceId);
    return !!summary?.coveredThrough && !summaryCovers(summary, hit.timestamp);
  }
  const kv = {
    ...store,
    writeGeneration: async () => 0,
    list: async <T>(scope: string): Promise<T[]> => {
      const rows = await store.list<T>(scope);
      if (!bounded || scenario === "unseen" || scope !== KV.injections || !await uncovered()) return rows;
      return rows.map((row) => {
        const record = row as InjectionRecord;
        return record.sessionId === "current"
          ? { ...record, injected: record.injected.filter((ref) => ref.kind !== "summary" || ref.id !== sourceId) } as T
          : row;
      });
    },
  };
  registerSummarizeFunction(sdk as never, kv as never, {
    name: "fixture",
    compress: async () => "",
    countTokens: async () => 10,
    summarize: async (_system, user) => {
      if (!recovered && user.includes("marker-2")) {
        rejected++;
        return "<garbage/>";
      }
      return `<summary><title>Manifest work</title><narrative>The export manifest planning is tracked for the fixture.</narrative><decisions><decision>${recovered && user.includes(decided) ? decided : "Keep the ordinary fixture layout."}</decision></decisions></summary>`;
    },
  });
  registerPromptContextFunction(sdk as never, kv as never);
  sdk.registerFunction("mem::search", async (query) => {
    const data = query as { query: string; project: string };
    if (data.query !== prompt || data.project !== "fixture") return { results: [] };
    const label = bounded && scenario !== "unseen" && await uncovered();
    return { results: [{ sessionId: sourceId, score: 20, observation: label ? { ...hit, narrative: evidence + hit.narrative } : hit }] };
  });
  await kv.set(KV.sessions, sourceId, { id: sourceId, project: "fixture", cwd: "/fixture", startedAt: stamp(0), status: "completed" });
  for (const item of observations) await kv.set(KV.observations(sourceId), item.id, item);
  await sdk.trigger("mem::summarize", { sessionId: sourceId });
  const partial = await kv.get<SessionSummary>(KV.summaries, sourceId);
  if (partial?.coveredThrough !== stamp(2) || rejected !== 2) throw new Error(`Middle chunk fixture did not fail as planned: ${partial?.coveredThrough} (${rejected})`);
  if (scenario !== "unseen") {
    await recordInjection(kv as never, { source: "prompt-submit", sessionId: "current", tokens: 1, injected: [{ kind: "summary", id: sourceId }] });
  }
  async function probe(sessionId: string) {
    return await sdk.trigger("mem::prompt-context", { sessionId, project: "fixture", prompt }) as PromptContextResult;
  }
  const before = await probe("current");
  await recordInjection(kv as never, { source: "prompt-submit", sessionId: "current", tokens: before.tokens, injected: before.injected });
  recovered = true;
  await sdk.trigger("mem::summarize", { sessionId: sourceId });
  const complete = await kv.get<SessionSummary>(KV.summaries, sourceId);
  if (!complete || !summaryCovers(complete, hit.timestamp) || !complete.keyDecisions.includes(decided)) throw new Error("Retry did not recover the decision");
  const after = await probe("current");
  const fresh = await probe("new-session");
  if (!fresh.context.includes(decided)) throw new Error("Fresh Session did not receive the recovered Summary");
  return {
    before: before.context.includes(decided) ? "correct" : before.context.includes(proposal) ? "stale" : "empty",
    labeled: before.context.includes(evidence),
    afterEvidence: after.injected.some((ref) => ref.kind === "observation") || fresh.injected.some((ref) => ref.kind === "observation"),
  };
}

export async function runExperiment() {
  const settings = { AGENTMEMORY_PROMPT_RERANK: "off", SUMMARIZE_CHUNK_TOKENS: "428", SUMMARIZE_CHUNK_CONCURRENCY: "1" };
  const previous = Object.keys(settings).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  try {
    const pairs = [];
    for (const scenario of scenarios) pairs.push({ scenario, baseline: await run(scenario, false), treatment: await run(scenario, true) });
    return pairs;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runExperiment(), null, 2));
}
