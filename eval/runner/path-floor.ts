import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

async function variant(): Promise<typeof registerPromptContextFunction> {
  let source = await readFile("src/functions/prompt-context.ts", "utf8");
  const replacements = [
    ["if (wordCount(prompt) < MIN_PROMPT_WORDS) return EMPTY;", String.raw`const below = wordCount(prompt) < MIN_PROMPT_WORDS;
      const exactPath = below && data.prompt.trim().split(/\s+/).find((token) => /^(?:[\w-]+\/)+[\w-]+\.[\w-]+$/.test(token));
      if (below && (!exactPath || !data.project)) return EMPTY;`],
    ["r.sessionId !== data.sessionId", "r.sessionId !== data.sessionId && (!exactPath || r.observation.files?.includes(exactPath))"],
    ["const lesson = lessons.find(", "const lesson = exactPath ? undefined : lessons.find("],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Path floor seam moved: ${before}`);
    source = source.replace(before, after);
  }
  await mkdir("tmp/path-floor", { recursive: true });
  const output = resolve("tmp/path-floor/treatment.mjs");
  await build({ stdin: { contents: source, resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  return (await import(pathToFileURL(output).href)).registerPromptContextFunction;
}

const stamp = "2026-11-23T00:00:00.000Z";
const records = [
  ["catalog", "fixture", "src/catalog.ts", "Apply the violet catalog format."],
  ["archive", "fixture", "src/archive.ts", "Use the local archive manifest."],
  ["noise", "fixture", "src/noise.ts", "A past edit renamed a comment."],
  ["wrong-directory", "fixture", "examples/private.ts", "Do not return the wrong-directory note."],
  ["foreign", "other", "src/private.ts", "Do not return the foreign-project note."],
] as const;
const cases = [
  { prompt: "src/catalog.ts", needed: records[0][3] },
  { prompt: "src/archive.ts", needed: records[1][3] },
  { prompt: "src/noise.ts", needed: null },
  { prompt: "src/private.ts", needed: null },
  { prompt: "again", needed: null },
  { prompt: "check src/noise.ts", needed: null },
];

export async function runExperiment() {
  const treatment = await variant();
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8").on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const { query, documents } = JSON.parse(raw) as { query: string; documents: string[] };
      calls++;
      if (query === "check src/noise.ts") {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: documents.map((doc, index) => ({ index, relevance_score: doc.includes("eligible-evidence") ? 0.9 : 0 })) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const settings = {
    AGENTMEMORY_PROMPT_RERANK: "on",
    AGENTMEMORY_PROMPT_RERANK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/rerank`,
    AGENTMEMORY_PROMPT_RERANK_MIN: "0.03",
    AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS: "1000",
  };
  const saved = Object.keys(settings).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  async function render(register: typeof registerPromptContextFunction, item: typeof cases[number]) {
    const kv = { ...mockKV(), writeGeneration: async () => 0 };
    const sdk = mockSdk();
    register(sdk as never, kv as never);
    for (const [id, , , text] of records) await kv.set(KV.summaries, id, { sessionId: id, title: id, keyDecisions: [text], createdAt: stamp, filesModified: [] });
    sdk.registerFunction("mem::search", async (data) => {
      const { query, project } = data as { query: string; project: string };
      return { results: query === item.prompt ? records.filter(([, scope]) => scope === project).map(([id, , path]) => ({
        sessionId: id, score: 20,
        observation: { id: `obs-${id}`, files: [path], timestamp: stamp, narrative: id === "catalog" || id === "archive" ? "eligible-evidence" : "unrelated note" },
      })) : [] };
    });
    const { context } = await sdk.trigger("mem::prompt-context", { sessionId: "new", prompt: item.prompt, project: "fixture" }) as PromptContextResult;
    if (context.includes(records[3][3]) || context.includes(records[4][3])) throw new Error("Wrong-directory or foreign hit escaped the filter");
    return !context ? "empty" : item.needed && context.includes(item.needed) ? "needed" : "irrelevant";
  }
  try {
    const results = [];
    for (const item of cases) {
      const before = calls;
      results.push({ prompt: item.prompt, baseline: await render(registerPromptContextFunction, item), treatment: await render(treatment, item), requests: calls - before });
    }
    return results;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((done) => server.close(() => done()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
