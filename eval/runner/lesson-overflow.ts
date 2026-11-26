import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

type Registrar = typeof registerContextFunction;
const budget = 180;
const seam = `if (usedTokens + block.tokens > budget) {
          if (block !== pinnedBlock) continue;`;
const treatment = `if (usedTokens + block.tokens > budget) {
          if (block === lessonsBlock) {
            const lines = block.content.split("\\n");
            const chosen = lines.slice(0, 2);
            const sources = [];
            for (const [i, line] of lines.slice(2).entries()) {
              const next = [...chosen, line].join("\\n");
              if (usedTokens + estimateTokens(next) <= budget) {
                chosen.push(line);
                if (block.sources?.[i]) sources.push(block.sources[i]);
              }
            }
            if (chosen.length > 2) {
              const content = chosen.join("\\n");
              selected.push(content);
              usedTokens += estimateTokens(content);
              injected.push(...sources);
            }
            continue;
          }
          if (block !== pinnedBlock) continue;`;

async function render(registrar: Registrar, mode: "pressure" | "control" | "counterexample" | "prefix") {
  const kv = mockKV();
  const sdk = mockSdk();
  const caseBudget = mode === "prefix" ? 300 : budget;
  registrar(sdk as never, kv as never, caseBudget);
  await kv.set(KV.memories, "rule", { id: "rule", type: "rule", project: "/synthetic", isLatest: true, content: "preserve the cobalt rule", updatedAt: "2026-11-22T00:00:00.000Z" });
  const long = mode === "control" ? "long violet instruction" : `long violet instruction ${"violet ".repeat(100)}`;
  const contents = mode === "prefix" ? ["first small instruction", long, "last small instruction"] : [long, "short amber instruction"];
  for (const [i, content] of contents.entries()) {
    const id = `lesson-${i}`;
    await kv.set(KV.lessons, id, { id, project: "/synthetic", content, confidence: i ? 0.8 : 0.9, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z" });
  }
  if (mode === "counterexample") {
    const id = "session";
    const startedAt = "2026-11-20T00:00:00.000Z";
    await kv.set(KV.sessions, id, { id, project: "/synthetic", cwd: "/synthetic", startedAt, status: "completed", observationCount: 1 });
    await kv.set(KV.observations(id), "obs", { id: "obs", title: "needed", narrative: `needed observation content ${"detail ".repeat(15)}`, type: "discovery", importance: 5, timestamp: startedAt });
  }
  return await sdk.trigger("mem::context", { sessionId: "current", project: "/synthetic", budget: caseBudget }) as { context: string; tokens: number };
}

export async function runExperiment() {
  const source = await readFile(resolve("src/functions/context.ts"), "utf8");
  if (source.split(seam).length !== 2) throw new Error("final packing seam changed");
  const output = resolve("tmp/lesson-overflow/prototype.mjs");
  await mkdir(resolve("tmp/lesson-overflow"), { recursive: true });
  await build({ stdin: { contents: source.replace(seam, treatment), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const candidate = (await import(pathToFileURL(output).href) as { registerContextFunction: Registrar }).registerContextFunction;
  async function pair(mode: "pressure" | "control" | "counterexample" | "prefix") {
    const a = await render(registerContextFunction, mode);
    const b = await render(candidate, mode);
    return { baseline: a.context, treatment: b.context, baselineTokens: a.tokens, treatmentTokens: b.tokens };
  }
  return { pressure: await pair("pressure"), control: await pair("control"), counterexample: await pair("counterexample"), prefix: await pair("prefix") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
