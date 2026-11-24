import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const budget = 180;
const original = 'const content = `## ${summary.title}\\n${summary.narrative}\\nDecisions: ${decisions.join("; ")}\\nFiles: ${files}`;';
const replacement = 'const content = decisions.length ? `## ${summary.title}\\nDecisions: ${decisions.join("; ")}` : `## ${summary.title}\\n${summary.narrative}\\nDecisions: ${decisions.join("; ")}\\nFiles: ${files}`;';
type Registrar = typeof registerContextFunction;
type Summary = { title: string; narrative: string; keyDecisions: string[]; filesModified: string[] };
type Case = { summaries: Summary[]; decisions: string[]; files: string[]; observation?: string };
const cases: Case[] = [
  { summaries: [
    { title: "new", narrative: "background ".repeat(35), keyDecisions: ["use violet protocol"], filesModified: ["src/violet.ts"] },
    { title: "old", narrative: "brief", keyDecisions: ["retain amber policy"], filesModified: [] },
  ], decisions: ["use violet protocol", "retain amber policy"], files: [] },
  { summaries: [{ title: "file need", narrative: "brief", keyDecisions: ["enable silver mode"], filesModified: ["src/needed-file.ts"] }], decisions: [], files: ["src/needed-file.ts"] },
  { summaries: [{ title: "decision need", narrative: "brief", keyDecisions: ["use bronze mode"], filesModified: [] }], decisions: ["use bronze mode"], files: [] },
  { summaries: [{ title: "reference cap", narrative: "brief", keyDecisions: [], filesModified: Array.from({ length: 11 }, (_, i) => `src/file-${i + 1}.ts`) }], decisions: [], files: ["src/file-11.ts"] },
  { summaries: [], decisions: [], files: [], observation: "observation control" },
];

async function render(registrar: Registrar, item: Case) {
  const kv = mockKV();
  const sdk = mockSdk();
  registrar(sdk as never, kv as never, budget);
  const summaries = item.summaries.length ? item.summaries : item.observation ? [null] : [];
  for (const [i, summary] of summaries.entries()) {
    const id = `session-${i}`;
    const startedAt = `2026-10-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`;
    await kv.set(KV.sessions, id, { id, project: "/synthetic", cwd: "/synthetic", startedAt, status: "completed", observationCount: 1 });
    if (summary) await kv.set(KV.summaries, id, { ...summary, sessionId: id, project: "/synthetic", createdAt: startedAt, concepts: [], observationCount: 1 });
    else await kv.set(KV.observations(id), "obs", { id: "obs", title: "control", narrative: item.observation, type: "discovery", importance: 5, timestamp: startedAt });
  }
  return await sdk.trigger("mem::context", { sessionId: "current", project: "/synthetic", budget }) as { context: string; injected: Array<{ files?: string[] }> };
}

export async function runExperiment() {
  const sourcePath = resolve("src/functions/context.ts");
  const source = await readFile(sourcePath, "utf8");
  if (!source.includes(original)) throw new Error("baseline Summary renderer changed; inspect prototype before rerunning");
  const output = resolve("tmp/summary-shortening/prototype.mjs");
  await mkdir(resolve("tmp/summary-shortening"), { recursive: true });
  await build({ stdin: { contents: source.replace(original, replacement), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const treatment = (await import(pathToFileURL(output).href) as { registerContextFunction: Registrar }).registerContextFunction;
  const results = await Promise.all(cases.map(async (item) => ({ item, baseline: await render(registerContextFunction, item), treatment: await render(treatment, item) })));
  function score(kind: "decisions" | "files") {
    let total = 0, baseline = 0, treatmentCount = 0, gained = 0, lost = 0;
    for (const row of results) for (const need of row.item[kind]) {
      total++;
      const a = row.baseline.context.includes(need), b = row.treatment.context.includes(need);
      baseline += Number(a); treatmentCount += Number(b); gained += Number(!a && b); lost += Number(a && !b);
    }
    return { total, baseline, treatment: treatmentCount, gained, lost };
  }
  return {
    budget,
    needs: { decisions: score("decisions"), files: score("files") },
    controls: {
      hiddenReference: results[3].baseline.injected.some((ref) => ref.files?.includes("src/file-11.ts")) && !results[3].baseline.context.includes("src/file-11.ts"),
      noSummarySame: results[4].baseline.context === results[4].treatment.context,
      decisionOnlySame: results[2].baseline.context.includes("use bronze mode") && results[2].treatment.context.includes("use bronze mode"),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
