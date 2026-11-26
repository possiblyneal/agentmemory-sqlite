import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { estimateTokens } from "../../src/utils/tokens.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

type Event =
  | { kind: "goal" | "plan" | "constraint"; text: string }
  | { kind: "edit"; revision: string }
  | { kind: "check"; revision: string; passed: boolean };

export function reconstruct(events: Event[]) {
  let objective = "";
  const constraints: string[] = [];
  const pending: string[] = [];
  let revision: string | null = null;
  let check: { revision: string; passed: boolean } | undefined;
  for (const event of events) {
    if (event.kind === "goal") objective = event.text;
    if (event.kind === "constraint") constraints.push(event.text);
    if (event.kind === "plan") pending.push(event.text);
    if (event.kind === "edit") revision = event.revision;
    if (event.kind === "check") check = event;
  }
  const checkCurrent = !!revision && check?.revision === revision && check.passed;
  return { objective, constraints, observed: { revision, checkCurrent }, inferred: { pending, next: !revision ? "edit" : checkCurrent ? "review" : "verify" } };
}

const goal = "Update the palette.";
const constraint = "Keep archive fixtures untouched.";
const cases: { name: string; events: Event[]; narrative: string; decisions: string[]; key: { revision: string | null; checkCurrent: boolean; next: string } }[] = [
  { name: "interrupted-after-edit", events: [{ kind: "constraint", text: constraint }, { kind: "edit", revision: "new" }], narrative: "Palette work started.", decisions: [], key: { revision: "new", checkCurrent: false, next: "verify" } },
  { name: "stale-check", events: [{ kind: "check", revision: "old", passed: true }, { kind: "edit", revision: "new" }, { kind: "constraint", text: constraint }], narrative: "Edited new. Check passed.", decisions: [constraint], key: { revision: "new", checkCurrent: false, next: "verify" } },
  { name: "plan-is-not-progress", events: [{ kind: "plan", text: "Maybe add a fixture" }, { kind: "constraint", text: constraint }], narrative: "Consider adding a fixture.", decisions: [constraint], key: { revision: null, checkCurrent: false, next: "edit" } },
];

export async function runExperiment() {
  const pairs = [];
  for (const item of cases) {
    const kv = mockKV();
    const sdk = mockSdk();
    const at = "2026-11-23T00:00:00Z";
    await kv.set(KV.sessions, "past", { id: "past", project: "fixture", startedAt: at, status: "completed", observationCount: 1 });
    await kv.set(KV.summaries, "past", { sessionId: "past", title: goal, narrative: item.narrative, keyDecisions: item.decisions, filesModified: [], createdAt: at });
    registerContextFunction(sdk as never, { ...kv, writeGeneration: async () => 0 } as never, 400);
    const { context } = await sdk.trigger("mem::context", { sessionId: "next", project: "fixture", budget: 400, agentId: "*" }) as { context: string };
    const revision = /Edited (\w+)\./.exec(context)?.[1] ?? null;
    const checkCurrent = context.includes("Check passed.");
    const start = performance.now();
    const state = reconstruct([{ kind: "goal", text: goal }, ...item.events]);
    const brief = JSON.stringify(state);
    const synthesisMs = performance.now() - start;
    function score(observed: { revision: string | null; checkCurrent: boolean }, next: string, text: string) {
      return { correct: next === item.key.next, repeat: next === "edit" && item.key.revision !== null,
        invented: observed.checkCurrent && !item.key.checkCurrent || observed.revision !== null && observed.revision !== item.key.revision,
        missed: !text.includes(constraint), tokens: estimateTokens(text) };
    }
    pairs.push({ name: item.name, baseline: score({ revision, checkCurrent }, !revision ? "edit" : checkCurrent ? "review" : "verify", context),
      treatment: score(state.observed, state.inferred.next, brief), synthesisMs });
  }
  return pairs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
