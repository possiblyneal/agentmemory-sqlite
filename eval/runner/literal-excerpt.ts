import { build } from "esbuild";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const budget = 200;
const at = "2026-11-22T00:00:00.000Z";
const cases = [
  { prompt: 'Which exact status is "LABEL_MISSING"?', narrative: "A parcel without a label reports LABEL_MISSING.", decision: "Keep unlabelled parcels in review.", detail: "LABEL_MISSING" },
  { prompt: 'What should we do after "ARCHIVE_STALE"?', narrative: "The reader reports ARCHIVE_STALE when its file predates the manifest.", decision: "Refresh the manifest before reopening the archive.", detail: "ARCHIVE_STALE", needDecision: true },
  { prompt: 'What should we do with "drafts/notes.md"?', narrative: "The notes file is drafts/notes.md.", decision: "Keep drafts/notes.md out of published archives.", detail: "drafts/notes.md", needDecision: true },
  { prompt: "When should we regenerate the covers?", narrative: "The watch script reran twice yesterday.", decision: "Regenerate covers only when an invoice changes.", needDecision: true },
];

async function render(registrar: typeof registerPromptContextFunction, item: typeof cases[number]) {
  const kv = mockKV();
  const sdk = mockSdk();
  const hit = { sessionId: "past", score: 20, observation: { id: "obs", timestamp: at, narrative: item.narrative } };
  sdk.registerFunction("mem::search", async () => ({ results: [hit] }));
  await kv.set(KV.summaries, "past", { sessionId: "past", title: "Parcel handling", keyDecisions: [item.decision], filesModified: [], createdAt: "2026-11-23T00:00:00.000Z" });
  registrar(sdk as never, kv as never);
  const result = await sdk.trigger("mem::prompt-context", { sessionId: "next", project: "synthetic", prompt: item.prompt }) as PromptContextResult;
  if (result.tokens > budget || result.injected.length !== 1) throw new Error("Fixture does not fit the same cap or did not render one eligible item");
  return result.context;
}

// Pre-measure rule: more literal answers available, no lost surrounding decisions, unchanged controls.
export async function runExperiment() {
  process.env.AGENTMEMORY_PROMPT_RERANK ??= "off";
  if (process.env.AGENTMEMORY_PROMPT_RERANK !== "off") throw new Error("Run this fixture with the gate off");
  const seam = "const { lines, injected } = renderWithSessionDecisions(withAmendments);";
  const original = await readFile(resolve("src/functions/prompt-context.ts"), "utf8");
  if (original.split(seam).length !== 2) throw new Error("Literal excerpt render seam changed");
  const replacement = `const literal = /"([^"\\n]+)"/.exec(prompt)?.[1];
      const first = withAmendments[0];
      const excerpt = literal && first?.summary && !first.summary.keyDecisions.some((text) => text.includes(literal))
        ? first.hit.observation.narrative.split(/(?<=\\.)\\s+/).find((line) => line.includes(literal))
        : undefined;
      const selected = excerpt && first ? [{ ...first, summary: undefined, hit: { ...first.hit, observation: { ...first.hit.observation, narrative: excerpt } } }, ...withAmendments.slice(1)] : withAmendments;
      const { lines, injected } = renderWithSessionDecisions(selected);`;
  const tmp = resolve("tmp/literal-excerpt");
  await mkdir(tmp, { recursive: true });
  const output = resolve(await mkdtemp(`${tmp}/build-`), "prototype.mjs");
  await build({ stdin: { contents: original.replace(seam, replacement), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const treated = (await import(pathToFileURL(output).href) as { registerPromptContextFunction: typeof registerPromptContextFunction }).registerPromptContextFunction;
  const paired = await Promise.all(cases.map(async (item) => ({ item, baseline: await render(registerPromptContextFunction, item), treatment: await render(treated, item) })));
  const score = (arm: "baseline" | "treatment") => ({
    details: paired.filter(({ item, [arm]: text }) => item.detail && text.includes(item.detail)).length,
    decisions: paired.filter(({ item, [arm]: text }) => item.needDecision && text.includes(item.decision)).length,
  });
  return { baseline: score("baseline"), treatment: score("treatment"), controlsChanged: paired.slice(2).filter((row) => row.baseline !== row.treatment).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
