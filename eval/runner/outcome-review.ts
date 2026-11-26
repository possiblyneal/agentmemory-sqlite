import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const prior = "Use the mint export palette.";
const corrected = "Use the iris export palette.";
const unrelated = "Keep the violet archive palette.";
const cases = [
  { name: "outdated", outcome: "iris", approved: corrected, expected: corrected },
  { name: "non-memory failure", outcome: "unavailable", approved: prior, expected: prior },
  { name: "agreement", outcome: "mint", approved: null, expected: prior },
] as const;

export async function runExperiment() {
  const results = [];
  let reviewMs = 0;
  for (const item of cases) {
    const kv = mockKV();
    const sdk = mockSdk();
    const project = "fixture";
    const timestamp = "2026-11-23T00:00:00Z";
    const rule = { id: "export", project, type: "rule", content: prior, isLatest: true, updatedAt: timestamp };
    const control = { ...rule, id: "archive", content: unrelated };
    const foreign = { ...rule, project: "foreign", id: "foreign" };
    await kv.set(KV.memories, rule.id, rule);
    await kv.set(KV.memories, control.id, control);
    await kv.set(KV.memories, foreign.id, foreign);
    if (item.approved) await kv.set(KV.observations("operator-source"), rule.id, { content: item.approved });
    registerContextFunction(sdk as never, { ...kv, writeGeneration: async () => 0 } as never, 400);
    async function probe(sessionId: string) {
      return await sdk.trigger("mem::context", { sessionId, project, budget: 400, agentId: "*" }) as { context: string; injected: { id: string }[] };
    }
    const first = await probe("first");
    const baseline = await probe("next-baseline");
    const flag = first.injected.some((ref) => ref.id === rule.id) && item.outcome !== "mint";
    let changed = false;
    if (flag) {
      const start = performance.now();
      const source = await kv.get<{ content: string }>(KV.observations("operator-source"), rule.id);
      changed = !!source && source.content !== rule.content;
      if (changed) await kv.set(KV.memories, rule.id, { ...rule, content: source!.content });
      reviewMs += performance.now() - start;
    }
    const treatment = await probe("next-treatment");
    results.push({ name: item.name, flag, changed, baselineCorrect: baseline.context.includes(item.expected), treatmentCorrect: treatment.context.includes(item.expected),
      untouched: JSON.stringify(await kv.get(KV.memories, control.id)) === JSON.stringify(control) &&
        JSON.stringify(await kv.get(KV.memories, foreign.id)) === JSON.stringify(foreign) && !treatment.injected.some((ref) => ref.id === foreign.id) });
  }
  return { cases: results, reviewMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
