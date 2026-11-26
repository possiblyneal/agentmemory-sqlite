import { build } from "esbuild";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const claim = "Keep signed invoices searchable within 30 days, except archived copies.";
const contents = [claim, claim, claim, "Keep draft invoices searchable after 24 hours.", "Keep signed invoices searchable after 60 days for reconciliation only."];
const needed = ["within 30 days", "except archived copies", "draft invoices", "after 24 hours", "for reconciliation only"];
const project = "synthetic";
const budget = 2000;

async function render(registrar: typeof registerContextFunction) {
  const kv = mockKV();
  const sdk = mockSdk();
  registrar(sdk as never, kv as never, budget);
  for (const [i, content] of contents.entries()) {
    const id = `insight-${i}`;
    const at = `2026-11-${10 + i}T00:00:00.000Z`;
    await kv.set(KV.insights, id, { id, title: `Invoice retrieval note ${i + 1}`, content, createdAt: at, updatedAt: at, project, confidence: 0.8 });
  }
  const before = JSON.stringify(await kv.list(KV.insights));
  const { context, tokens } = await sdk.trigger("mem::context", { sessionId: "next", project, budget }) as { context: string; tokens: number };
  return {
    tokens, delivered: needed.filter((text) => context.includes(text)).length,
    repeated: Math.max(0, context.split(claim).length - 2),
    storageChanged: before !== JSON.stringify(await kv.list(KV.insights)),
  };
}

// Pre-measure rule: all needed claims survive, 8 or more estimated tokens saved, no storage mutation.
export async function runExperiment() {
  const seam = ".slice(0, 5)\n        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));";
  const original = await readFile(resolve("src/functions/context.ts"), "utf8");
  if (original.split(seam).length !== 2) throw new Error("Insight render seam changed");
  const replacement = seam.slice(0, -1) + "\n        .filter((insight, index, rows) => rows.findIndex((earlier) => earlier.content === insight.content) === index);";
  const tmp = resolve("tmp/insight-render-dedup");
  await mkdir(tmp, { recursive: true });
  const output = resolve(await mkdtemp(`${tmp}/build-`), "prototype.mjs");
  await build({ stdin: { contents: original.replace(seam, replacement), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const treatmentRegistrar = (await import(pathToFileURL(output).href) as { registerContextFunction: typeof registerContextFunction }).registerContextFunction;
  const [baseline, treatment] = await Promise.all([render(registerContextFunction), render(treatmentRegistrar)]);
  return { baseline, treatment, storageChanged: baseline.storageChanged || treatment.storageChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
