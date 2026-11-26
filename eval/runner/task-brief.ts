import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { KV } from "../../src/state/schema.js";
import { estimateTokens } from "../../src/utils/tokens.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const rule = "Preserve the audit log.";
const foreign = "Use the foreign palette for exports.";
const fallback = "Use mint for exports.";
const exception = "Use iris for nightly exports.";
const standard = "Use rose for exports.";
const evidence = "Check the palette fixture.";
const scenarios = [
  { name: "exception", prompt: "Which palette applies to nightly exports?", decisions: [fallback, exception], correct: exception, wrong: fallback },
  { name: "standard", prompt: "Which palette applies to ordinary exports?", decisions: [standard, standard], correct: standard, wrong: "" },
  { name: "compile-failure", prompt: "Which palette applies to ordinary exports?", decisions: [standard], correct: standard, wrong: "" },
] as const;

export function compileBrief(startup: string, submit = "", prompt = ""): string {
  const bullet = (text: string) => text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  const sections = startup.split("\n\n");
  const rules = sections.filter((section) => section.split("\n").includes("## Rules")).flatMap(bullet);
  const evidence = [...new Set(startup.split("\n").filter((line) => line.startsWith("Evidence: ")))];
  const priorDecisions = startup.split("\n").filter((line) => line.startsWith("Decisions: ")).flatMap((line) => line.slice(11).split("; "));
  const decisions = [...new Set([...bullet(submit), ...priorDecisions])];
  const words = new Set(prompt.toLowerCase().match(/\p{L}+/gu) ?? []);
  const overlap = (line: string) => new Set(line.toLowerCase().match(/\p{L}+/gu)?.filter((word) => words.has(word))).size;
  decisions.sort((a, b) => overlap(b) - overlap(a));
  return ["Project memory brief", ...rules.map((line) => `Rule: ${line}`), ...decisions.map((line) => `Decision: ${line}`), ...evidence].join("\n");
}

async function render(item: typeof scenarios[number]) {
  const kv = mockKV();
  const sdk = mockSdk();
  const fixture = { ...kv, writeGeneration: async () => 0 };
  registerContextFunction(sdk as never, fixture as never, 400);
  registerPromptContextFunction(sdk as never, fixture as never);
  const timestamp = "2026-11-23T00:00:00Z";
  for (const project of ["local", "foreign"]) {
    const id = `${project}-source`;
    await kv.set(KV.sessions, id, { id, project, cwd: `/fixture/${project}`, startedAt: timestamp, status: "completed", observationCount: 1 });
    await kv.set(KV.summaries, id, { sessionId: id, project, createdAt: timestamp, title: "Export palette", narrative: `Evidence: ${evidence}`, keyDecisions: project === "local" ? item.decisions : [foreign], filesModified: [] });
    const ruleId = `${project}-rule`;
    await kv.set(KV.memories, ruleId, { id: ruleId, project, type: "rule", content: project === "local" ? rule : foreign, isLatest: true, updatedAt: timestamp });
  }
  sdk.registerFunction("mem::search", async (data) => {
    const payload = data as { query: string; project: string };
    return { results: payload.query === item.prompt && payload.project === "local" ? [{ sessionId: "local-source", score: 20, observation: { id: "obs", narrative: evidence, timestamp } }] : [] };
  });
  const startup = await sdk.trigger("mem::context", { sessionId: "current", project: "local", budget: 400, agentId: "*" }) as { context: string };
  const submit = await sdk.trigger("mem::prompt-context", { sessionId: "current", project: "local", prompt: item.prompt }) as PromptContextResult;
  if (!startup.context.includes(rule) || !submit.injected.some((ref) => ref.kind === "summary")) throw new Error("Baseline did not render the pinned Rule and matched Summary");
  return { startup: startup.context, submit: submit.context };
}

function score(item: typeof scenarios[number], startup: string, submit: string) {
  const newestFirst = `${submit}\n${startup}`;
  const correctAt = newestFirst.indexOf(item.correct);
  const wrongAt = item.wrong ? newestFirst.indexOf(item.wrong) : -1;
  const stale = wrongAt >= 0 && (correctAt < 0 || wrongAt < correctAt);
  return { correctFirst: correctAt >= 0 && !stale, stale, rule: startup.includes(rule), exception: !item.decisions.some((decision) => decision === exception) || newestFirst.includes(exception),
    evidence: newestFirst.includes(evidence), foreign: newestFirst.includes(foreign), tokens: estimateTokens(startup) + estimateTokens(submit) };
}

export async function runExperiment() {
  const previous = process.env.AGENTMEMORY_PROMPT_RERANK;
  process.env.AGENTMEMORY_PROMPT_RERANK = "off";
  try {
    const pairs = [];
    for (const item of scenarios) {
      const current = await render(item);
      const start = performance.now();
      const startup = compileBrief(current.startup);
      let submit = current.submit;
      let failure = false;
      try {
        if (item.name === "compile-failure") throw new Error("scripted compiler failure");
        submit = compileBrief(current.startup, current.submit, item.prompt);
      } catch { failure = true; }
      const synthesisMs = performance.now() - start;
      pairs.push({ name: item.name, baseline: score(item, current.startup, current.submit), treatment: score(item, startup, submit), synthesisMs, failure });
    }
    return pairs;
  } finally {
    if (previous === undefined) delete process.env.AGENTMEMORY_PROMPT_RERANK;
    else process.env.AGENTMEMORY_PROMPT_RERANK = previous;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
