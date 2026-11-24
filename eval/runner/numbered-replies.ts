import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { SearchIndex } from "../../src/state/search-index.js";
import type { CompressedObservation } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const topics = [
  ["catalog", "parchment catalog typography", "glossy brochure typography"],
  ["invoice", "itemized invoice currency rounding", "consolidated receipt taxation"],
  ["warehouse", "quarterly inventory reconciliation", "weekly shipment dispatch"],
] as const;
const replyFor = ([topic, first, second]: typeof topics[number]) => `Which ${topic} plan should we use?\n1. ${first}\n2. ${second}`;
const examples = [
  { prompt: "1", reply: replyFor(topics[0]), useful: "reference catalog-1", rejected: "reference catalog-2" },
  { prompt: "2", reply: replyFor(topics[1]), useful: "reference invoice-2", rejected: "reference invoice-1" },
  { prompt: "1", reply: replyFor(topics[2]), useful: "reference warehouse-1", rejected: "reference warehouse-2" },
];
const controls = [
  { prompt: "3", reply: replyFor(topics[0]) },
  { prompt: "1 or 2", reply: replyFor(topics[0]) },
  { prompt: "1", reply: replyFor(topics[0]).replace("2.", "1.") },
  { prompt: "Please review the consolidated receipt taxation", reply: replyFor(topics[1]) },
];

function narrow(prompt: string, reply: string) {
  const selection = /^([1-9]\d*)$/.exec(prompt.trim());
  const [question, ...lines] = reply.trim().split("\n");
  if (!selection || !question?.endsWith("?") || lines.length < 2 || reply.length > 1000) return reply;
  const options = lines.map((line) => /^([1-9]\d*)\. (\S.*)$/.exec(line));
  if (options.some((option, i) => option?.[1] !== String(i + 1))) return reply;
  const chosen = options[Number(selection[1]) - 1]?.[2];
  return chosen ? `${question}\n${chosen}` : reply;
}

// Pre-measure rule: more useful hits, fewer rejected-only hits, no changed control Injection.
export async function runExperiment() {
  process.env.AGENTMEMORY_PROMPT_RERANK ??= "off";
  if (process.env.AGENTMEMORY_PROMPT_RERANK !== "off") throw new Error("Run this BM25-only fixture with the gate off");
  const observations = new Map<string, CompressedObservation>();
  const index = new SearchIndex();
  function add(id: string, title: string) {
    const observation: CompressedObservation = { id, sessionId: id, type: "discovery", title, narrative: `Use ${title}; reference ${id}.`, timestamp: "2026-11-23T00:00:00.000Z", concepts: [], facts: [], files: [], importance: 5 };
    observations.set(id, observation);
    index.add(observation);
  }
  for (const [topic, first, second] of topics) {
    add(`${topic}-1`, first);
    add(`${topic}-2`, second);
  }
  for (let i = 0; i < 30; i++) add(`unrelated-${i}`, "Sample storage cabinet directory");

  async function render(prompt: string, reply: string) {
    const sdk = mockSdk();
    sdk.registerFunction("mem::search", async ({ query }: { query: string }) => ({
      results: index.search(query).map(({ obsId, sessionId, score }) => ({ sessionId, score, observation: observations.get(obsId) })),
    }));
    registerPromptContextFunction(sdk as never, mockKV() as never);
    return (await sdk.trigger("mem::prompt-context", { sessionId: "next", project: "synthetic", prompt, reply }) as PromptContextResult).context;
  }
  const paired = await Promise.all([...examples, ...controls].map(async ({ prompt, reply }) => ({
    baseline: await render(prompt, reply), treatment: await render(prompt, narrow(prompt, reply)),
  })));
  function score(arm: "baseline" | "treatment") {
    return {
      useful: examples.filter((example, i) => paired[i]![arm].includes(`${example.useful}.`)).length,
      rejected: examples.filter((example, i) => paired[i]![arm].includes(`${example.rejected}.`)).length,
    };
  }
  return { choices: examples.length, controls: controls.length, controlsChanged: paired.slice(examples.length).filter((row) => row.baseline !== row.treatment).length, baseline: score("baseline"), treatment: score("treatment") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
