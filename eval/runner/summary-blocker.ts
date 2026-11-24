import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerRecompressOrphansFunction } from "../../src/functions/recompress-orphans.js";
import { registerSummarizeFunction, summaryCovers } from "../../src/functions/summarize.js";
import { KV } from "../../src/state/schema.js";
import type { SessionSummary } from "../../src/types.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const decision = "Use the violet manifest for exports.";
const stamp = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const blocker = { observationId: "blocker", sessionId: "waiting" };
type Job = { observationId: string; sessionId: string };

async function run(backlog: number, priority: boolean) {
  const store = mockKV();
  const sdk = mockSdk({ looseTrigger: true });
  const kv = {
    ...store,
    list: async <T>(scope: string): Promise<T[]> => {
      const rows = await store.list<T>(scope);
      if (!priority || scope !== KV.compressPending) return rows;
      return rows.sort((a, b) => Number((b as Job).observationId === blocker.observationId) - Number((a as Job).observationId === blocker.observationId));
    },
  };
  const background = new Map<string, number>();
  const delays: number[] = [];
  let clock = 0;
  let timeouts = 0;
  let coverage: number | undefined;
  let earlyDecision = false;
  let summaryCalls = 0;

  const observation = (id: string, sessionId: string, second: number, narrative: string, awaitingCompression = false) => ({
    id, sessionId, timestamp: stamp(second), title: id, narrative,
    type: "conversation", facts: [], files: [], concepts: [], importance: 5, awaitingCompression,
  });
  await kv.set(KV.sessions, "waiting", { id: "waiting", project: "fixture", cwd: "/fixture", startedAt: stamp(0), status: "completed" });
  const needed = observation("decision", "waiting", 2, decision);
  async function add(job: Job, arrival: number) {
    const { observationId, sessionId } = job;
    await kv.set(KV.observations(sessionId), observationId, observation(observationId, sessionId, 1, "Pending evidence", true));
    await kv.set(KV.compressPending, observationId, { ...job, reason: "compression_failed" });
    if (job !== blocker) background.set(observationId, arrival);
  }
  const addBackground = (id: string, arrival: number) => add({ observationId: id, sessionId: id }, arrival);
  for (let i = 0; i < backlog; i++) await addBackground(`backlog-${i}`, 0);
  await add(blocker, 0);
  await kv.set(KV.observations("waiting"), needed.id, needed);

  registerRecompressOrphansFunction(sdk as never, kv as never);
  registerSummarizeFunction(sdk as never, kv as never, {
    name: "fixture",
    compress: async () => "",
    summarize: async (_system, prompt) => {
      summaryCalls++;
      const decisions = prompt.includes(decision) ? `<decision>${decision}</decision>` : "";
      return `<summary><title>Manifest selection</title><narrative>The export manifest was selected for the upcoming work.</narrative><decisions>${decisions}</decisions></summary>`;
    },
  });
  sdk.registerFunction("mem::compress", async (payload) => {
    const { observationId, sessionId } = payload as Job;
    clock += 2;
    if (observationId === "slow" && timeouts === 0) {
      timeouts++;
      return { success: false };
    }
    await kv.set(KV.observations(sessionId), observationId, observation(observationId, sessionId, 1, "Recovered evidence"));
    await kv.delete(KV.compressPending, observationId);
    const arrival = background.get(observationId);
    if (arrival !== undefined) {
      delays.push(clock - arrival);
      background.delete(observationId);
    }
    return { success: true };
  });

  async function probe(at: number) {
    await sdk.trigger("mem::summarize", { sessionId: "waiting" });
    const summary = await kv.get<SessionSummary>(KV.summaries, "waiting");
    if (!summary?.keyDecisions.includes(decision)) throw new Error("Fixture decision absent");
    if (summaryCovers(summary, needed.timestamp)) coverage ??= at;
    else earlyDecision = true;
  }
  await probe(0);
  for (let start = 0; start < 80; start += 10) {
    clock = start;
    if (start > 0 && start <= 40) await addBackground(start === 40 ? "slow" : `arrival-${start}`, start);
    await sdk.trigger("mem::recompress-orphans", { limit: 2 });
    await probe(start + 5);
  }
  if (coverage === undefined || !earlyDecision || background.size !== 0) throw new Error("Incomplete fixture run");
  return { coverage, timeouts, backgroundMax: Math.max(...delays), completedBackground: delays.length, summaryCalls };
}

export async function runExperiment() {
  const pairs = [];
  for (const backlog of [2, 4, 6]) {
    pairs.push({ backlog, baseline: await run(backlog, false), treatment: await run(backlog, true) });
  }
  return pairs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runExperiment(), null, 2));
}
