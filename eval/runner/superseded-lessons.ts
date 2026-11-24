import { build } from "esbuild";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const project = "synthetic";
const budget = 2000;
const old = "2026-10-01T00:00:00.000Z";
const recent = "2026-10-02T00:00:00.000Z";
const cases = [
  { id: "labels", lesson: "label format = compact", rule: "label format = expanded", target: "label format", expected: "expanded", contradicts: true },
  { id: "archive", lesson: "archive period = 45d", rule: "archive period = 60d", target: "archive period", expected: "60d", contradicts: true },
  { id: "unchanged", lesson: "catalog size = A5", rule: "catalog size = A5", target: "catalog size", expected: "A5" },
  { id: "similar", lesson: "draft catalog size = A5", rule: "catalog size = A4", target: "draft catalog size", expected: "A5" },
  { id: "other-project", lesson: "label format = compact", rule: "label format = expanded", target: "label format", expected: "compact", ruleProject: "other", contradicts: true },
  { id: "fresh-lesson", lesson: "archive period = 60d", rule: "archive period = 45d", target: "archive period", expected: "60d", lessonAt: recent, ruleAt: old, contradicts: true },
];

type Case = typeof cases[number];
type Registrar = typeof registerContextFunction;

// Pre-measure rule: strictly fewer stale actions, zero losses of correct actions, no changed control or stored Lesson.
async function render(registrar: Registrar, item: Case) {
  const kv = mockKV();
  const sdk = mockSdk();
  registrar(sdk as never, kv as never, budget);
  const lessonAt = item.lessonAt ?? old;
  const lesson = { id: item.id, content: item.lesson, project, confidence: 0.9, reinforcements: 1, createdAt: lessonAt, updatedAt: lessonAt, tags: [] };
  const stored = JSON.stringify(lesson);
  await kv.set(KV.lessons, item.id, lesson);
  await kv.set(KV.memories, `rule-${item.id}`, { id: `rule-${item.id}`, content: item.rule, project: item.ruleProject ?? project, type: "rule", isLatest: true, updatedAt: item.ruleAt ?? recent });
  const { context } = await sdk.trigger("mem::context", { sessionId: "next", project, budget }) as { context: string };
  const [rules, lessons] = context.split("## Lessons Learned");
  const value = [lessons, rules].flatMap((block) => block?.match(new RegExp(`\\b${item.target} = ([^\\s]+)`))?.[1] ?? [])[0];
  return { value, context, storedLessonChanged: stored !== JSON.stringify(await kv.get(KV.lessons, item.id)) };
}

export async function runExperiment() {
  const seam = 'lessons.filter((l) => !l.project || l.project === data.project)';
  const contradictions = Object.fromEntries(cases.filter((item) => item.contradicts).map((item) => [item.id, `rule-${item.id}`]));
  const sourcePath = resolve("src/functions/context.ts");
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(sourcePath, "utf8"));
  if (source.split(seam).length !== 2) throw new Error("Lesson render seam changed");
  const replacement = `lessons.filter((l) => (!l.project || l.project === data.project) && !ruleMemories.some((rule) => l.project === data.project && rule.project === data.project && pinnedRuleIds.has(rule.id) && rule.updatedAt > (l.lastReinforcedAt || l.updatedAt) && (${JSON.stringify(contradictions)} as Record<string, string>)[l.id] === rule.id))`;
  const scratch = resolve("tmp/superseded-lessons");
  await mkdir(scratch, { recursive: true });
  const output = resolve(await mkdtemp(`${scratch}/build-`), "prototype.mjs");
  await build({ stdin: { contents: source.replace(seam, replacement), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const treatment = (await import(pathToFileURL(output).href) as { registerContextFunction: Registrar }).registerContextFunction;
  const results = await Promise.all(cases.map(async (item) => ({ item, a: await render(registerContextFunction, item), b: await render(treatment, item) })));
  const score = (arm: "a" | "b") => ({
    stale: results.filter(({ item, [arm]: row }) => row.value !== item.expected && row.value === item.lesson.split(" = ")[1]).length,
    correct: results.filter(({ item, [arm]: row }) => row.value === item.expected).length,
  });
  return {
    cases: results.length,
    baseline: score("a"),
    treatment: score("b"),
    controlsChanged: results.slice(2).filter(({ a, b }) => a.context !== b.context).length,
    storedLessonsChanged: results.filter(({ a, b }) => a.storedLessonChanged || b.storedLessonChanged).length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
