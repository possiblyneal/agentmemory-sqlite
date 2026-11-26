import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getSearchIndex, rebuildIndex, registerSearchFunction } from "../../src/functions/search.js";
import { fetchWithTimeout } from "../../src/providers/_fetch.js";
import { KV } from "../../src/state/schema.js";
import type { SearchResult } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";
import { appendDurable, startNdjson } from "./durable.js";

const dev = [
  ["beacon", "iris", "mint", "iris"], ["binder", "blue", "rose", "blue"],
  ["canvas", "lime", "ruby", "lime"], ["drawer", "teal", "plum", "teal"],
  ["folder", "pink", "gold", "pink"], ["jigsaw", "jade", "navy", "navy"],
  ["lattice", "opal", "sand", "opal"], ["mosaic", "gray", "rust", "gray"],
] as const;
const heldBack = [
  ["parcel", "sage", "dusk", "sage"], ["quartz", "cyan", "peach", "cyan"],
  ["ribbon", "snow", "silk", "silk"], ["stencil", "fern", "fern", "fern"],
] as const;

type Outcome = { type: string; success: boolean };
export function rankByOutcome<T extends { type: string }>(ranked: readonly T[], trials: Outcome[]): T {
  function rate(type: string) {
    const seen = trials.filter((row) => row.type === type);
    return seen.length ? seen.filter((row) => row.success).length / seen.length : 0;
  }
  return ranked.reduce((best, hit) => rate(hit.type) > rate(best.type) ? hit : best);
}

export function scoreAction(reply: string, expected: string, stale: string) {
  try {
    const row = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (row && Object.keys(row).length === 1) {
      return { success: row.value === expected, stale: stale !== expected && row.value === stale };
    }
  } catch { /* An unparseable answer supplies no action. */ }
  return { success: false, stale: false };
}

function randomizedExposures() {
  const exposures = ["decision", "file_edit", "decision", "file_edit", "decision", "file_edit", "decision", "file_edit"];
  let seed = 42;
  for (let i = exposures.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(seed / 2 ** 32 * (i + 1));
    [exposures[i], exposures[j]] = [exposures[j]!, exposures[i]!];
  }
  return exposures;
}

async function prepareSearch() {
  const kv = mockKV();
  const sdk = mockSdk();
  registerSearchFunction(sdk as never, kv as never);
  for (const [project, decision, edit] of [...dev, ...heldBack]) {
    const timestamp = "2026-11-23T00:00:00Z";
    await kv.set(KV.sessions, project, { id: project, project, cwd: `/fixture/${project}`, startedAt: timestamp, status: "completed", observationCount: 2 });
    for (const [type, title, value] of [
      ["decision", `Palette note`, decision], ["file_edit", `${project} theme configuration`, edit],
    ] as const) {
      const id = `${project}-${type}`;
      await kv.set(KV.observations(project), id, { id, sessionId: project, type, title, timestamp, narrative: `Set the theme value to ${value}.`, facts: [], files: [], concepts: [], importance: 5 });
    }
  }
  getSearchIndex().clear();
  await rebuildIndex(kv as never);
  return async (project: string) => {
    const { results } = await sdk.trigger("mem::search", { query: `${project} theme configuration`, project, limit: 2, agentId: "*" }) as { results: SearchResult[] };
    const hits = results.map(({ observation }) => observation);
    if (hits.length !== 2 || hits.some((hit) => hit.sessionId !== project)) throw new Error(`Bad Recall pool: ${project}`);
    return hits;
  };
}

type Trial = Outcome & { revision: string; hash: string; task: string; arm: string; stale: boolean; reply: string; promptTokens: number; selectionMs: number; modelMs: number };
async function run() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
  const output = "tmp/outcome-ranking/trials.ndjson";
  mkdirSync("tmp/outcome-ranking", { recursive: true });
  const rows = startNdjson<Trial>(output, process.argv.includes("--resume"));
  if (rows.some((row) => row.revision !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
  const search = await prepareSearch();
  async function action(task: string, arm: string, expected: string, stale: string, hit: { type: string; narrative: string }, selectionMs: number) {
    if (rows.some((row) => row.task === task && row.arm === arm)) return;
    const start = performance.now();
    const response = await fetchWithTimeout("http://ai.lan:4010/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "general-eval-b", temperature: 0, seed: 42, max_tokens: 2048, stream: false,
        messages: [{ role: "user", content: `Update the ${task} fixture's theme. Reply with exactly one JSON action {"value":"<theme>"}. Do not explain. Retrieved note: ${hit.narrative}` }] }),
    }, 60_000);
    if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
    const body = await response.json() as { choices: { message: { content: string | null } }[]; usage: { prompt_tokens: number } };
    const reply = body.choices[0]?.message.content ?? "";
    const row = { revision, hash, task, arm, type: hit.type, reply, ...scoreAction(reply, expected, stale),
      promptTokens: body.usage.prompt_tokens, selectionMs, modelMs: Math.round(performance.now() - start) };
    appendDurable(output, row);
    rows.push(row);
    console.log(JSON.stringify({ task, arm, type: hit.type, success: row.success, stale: row.stale, promptTokens: row.promptTokens, selectionMs, modelMs: row.modelMs }));
  }
  const exposures = randomizedExposures();
  for (const [[task, decision, edit, expected], i] of dev.map((task, i) => [task, i] as const)) {
    const start = performance.now();
    const hits = await search(task);
    const hit = hits.find((hit) => hit.type === exposures[i]);
    if (!hit) throw new Error(`Missing randomized exposure: ${task}`);
    await action(task, "dev", expected, expected === decision ? edit : decision, hit, performance.now() - start);
  }
  const training = rows.filter((row) => row.arm === "dev");
  for (const [i, [task, decision, edit, expected]] of heldBack.entries()) {
    const stale = expected === decision ? edit : decision;
    const start = performance.now();
    const hits = await search(task);
    const baselineMs = performance.now() - start;
    const rerankStart = performance.now();
    const reranked = rankByOutcome(hits, training);
    const rerankMs = baselineMs + performance.now() - rerankStart;
    const arms = [["baseline", hits[0]!, baselineMs], ["treatment", reranked, rerankMs]] as const;
    for (const [arm, hit, ms] of (i % 2 ? [...arms].reverse() : arms)) await action(task, arm, expected, stale, hit, ms);
  }
  console.log("DONE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
