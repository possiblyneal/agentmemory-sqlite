import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recordInjection } from "../../src/functions/injections.js";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { KV } from "../../src/state/schema.js";
import type { InjectionRecord } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const cases = [
  { name: "novel", prior: "Keep exports in review.", detail: "Export error CODE_A requires retry after 9 minutes.", question: 'What is the "CODE_A" retry delay?', answer: "9 minutes", wrong: false },
  { name: "visible", prior: "Export error CODE_B requires retry after 5 minutes.", detail: "Export error CODE_B requires retry after 5 minutes.", question: 'What is the "CODE_B" retry delay?', answer: "5 minutes", wrong: false },
  { name: "wrong-condition", prior: "Use the online export policy.", detail: "For offline exports CODE_C requires retry after 2 minutes.", question: 'What is the online "CODE_C" retry delay?', answer: "2 minutes", wrong: true },
] as const;

async function trial(item: typeof cases[number], treatment: boolean) {
  const store = mockKV();
  const sdk = mockSdk();
  let allow = false;
  const kv = {
    ...store,
    writeGeneration: async () => 0,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      if (allow && scope === KV.summaries && key === "past") return null;
      return store.get<T>(scope, key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const rows = await store.list<T>(scope);
      if (!allow || scope !== KV.injections) return rows;
      return rows.map((row) => {
        const record = row as InjectionRecord;
        return record.sessionId === "current" ? { ...record, injected: record.injected.filter((ref) => ref.kind !== "summary" || ref.id !== "past") } as T : row;
      });
    },
  };
  registerPromptContextFunction(sdk as never, kv as never);
  const initialPrompt = "What policy applies to exports?";
  sdk.registerFunction("mem::search", async (data) => {
    const { query, project } = data as { query: string; project: string };
    return { results: project === "fixture" && (query === initialPrompt || query === item.question) ? [{ sessionId: "past", score: 20, observation: { id: "obs", narrative: item.detail, timestamp: "2026-11-22T00:00:00.000Z" } }] : [] };
  });
  await store.set(KV.summaries, "past", { sessionId: "past", title: "Export policy", keyDecisions: [item.prior], filesModified: [], createdAt: "2026-11-23T00:00:00.000Z" });
  async function inject(prompt: string) {
    const result = await sdk.trigger("mem::prompt-context", { sessionId: "current", project: "fixture", prompt }) as PromptContextResult;
    if (result.tokens > 200 || result.injected.length > 3) throw new Error("Fixture exceeds shared budget or cap");
    await recordInjection(store as never, { sessionId: "current", project: "fixture", source: "prompt-submit", injected: result.injected, tokens: result.tokens });
    return result;
  }
  const first = await inject(initialPrompt);
  if (!first.injected.some((ref) => ref.kind === "summary" && ref.id === "past") || !first.context.includes(item.prior)) throw new Error("Prior Summary was not actually delivered");
  const literal = /"([^"]+)"/.exec(item.question)?.[1];
  allow = treatment && !!literal && item.detail.includes(literal) && !first.context.includes(item.answer);
  const second = await inject(item.question);
  const third = await inject(item.question);
  return { needed: !item.wrong && (first.context + second.context).includes(item.answer) ? 1 : 0, wrong: item.wrong && second.context.includes(item.answer) ? 1 : 0, repeat: third.context.includes(item.detail) ? 1 : 0 };
}

// Frozen before measurement: at least one additional needed detail, zero repeat or wrong evidence.
export async function runExperiment() {
  const old = process.env.AGENTMEMORY_PROMPT_RERANK;
  process.env.AGENTMEMORY_PROMPT_RERANK = "off";
  try {
    const pairs: { baseline: Awaited<ReturnType<typeof trial>>; treatment: Awaited<ReturnType<typeof trial>> }[] = [];
    for (const item of cases) pairs.push({ baseline: await trial(item, false), treatment: await trial(item, true) });
    const total = (arm: "baseline" | "treatment") => pairs.reduce((sum, pair) => ({ needed: sum.needed + pair[arm].needed, wrong: sum.wrong + pair[arm].wrong, repeat: sum.repeat + pair[arm].repeat }), { needed: 0, wrong: 0, repeat: 0 });
    return { baseline: total("baseline"), treatment: total("treatment") };
  } finally {
    if (old === undefined) delete process.env.AGENTMEMORY_PROMPT_RERANK; else process.env.AGENTMEMORY_PROMPT_RERANK = old;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
