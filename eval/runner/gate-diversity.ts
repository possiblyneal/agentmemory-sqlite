import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPromptContextFunction, type PromptContextResult } from "../../src/functions/prompt-context.js";
import { INJECT_TIMEOUT_MS } from "../../src/hooks/_missed-injection.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

const seam = `      const pool = lesson
        ? [...candidates.slice(0, GATE_POOL - 1), lessonCandidate(lesson)]
        : candidates.slice(0, GATE_POOL);`;
const replacement = `      const first: Candidate[] = [];
      const backfill: Candidate[] = [];
      const covered = new Set<string>();
      for (const candidate of await withCoveringSummaries(kv, candidates)) {
        if (candidate.summary && covered.has(candidate.hit.sessionId)) {
          backfill.push(candidate);
          continue;
        }
        if (candidate.summary) covered.add(candidate.hit.sessionId);
        first.push(candidate);
      }
      const pool = [...first, ...backfill].slice(0, lesson ? GATE_POOL - 1 : GATE_POOL);
      if (lesson) pool.push(lessonCandidate(lesson));`;

async function variant(): Promise<typeof registerPromptContextFunction> {
  const source = await readFile("src/functions/prompt-context.ts", "utf8");
  if (source.split(seam).length !== 2) throw new Error("Gate pool seam moved");
  await mkdir("tmp/gate-diversity", { recursive: true });
  const output = resolve("tmp/gate-diversity/treatment.mjs");
  await build({ stdin: { contents: source.replace(seam, replacement), resolveDir: resolve("src/functions"), loader: "ts" }, outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  return (await import(pathToFileURL(output).href)).registerPromptContextFunction;
}

const prompt = "How should we validate fixture parcel dispatch?";
const stamp = "2026-11-23T00:00:00.000Z";
const decision = "Validate fixture parcel dispatch against the violet manifest.";
const cases = {
  crowded: { sessions: [...Array<string>(9).fill("filler"), "needed"], winningIndex: 9 },
  second: { sessions: ["needed", "needed", ...Array.from({ length: 8 }, (_, i) => `filler-${i}`)], winningIndex: 1 },
};

export async function runExperiment() {
  const treatment = await variant();
  let pool: string[] = [];
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8").on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      pool = (JSON.parse(raw) as { documents: string[] }).documents;
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: pool.map((doc, index) => ({ index, relevance_score: doc.includes("winning-evidence") ? 0.95 : doc.includes("fixture-lesson") ? 0.8 : 0 })) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const settings = {
    AGENTMEMORY_PROMPT_RERANK: "on",
    AGENTMEMORY_PROMPT_RERANK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/rerank`,
    AGENTMEMORY_PROMPT_RERANK_MIN: "0.03",
    AGENTMEMORY_PROMPT_LESSON_MIN: "0.5",
    AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS: "1000",
  };
  const saved = Object.keys(settings).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  async function render(register: typeof registerPromptContextFunction, item: typeof cases[keyof typeof cases]) {
    const sdk = mockSdk();
    const kv = { ...mockKV(), writeGeneration: async () => 0 };
    register(sdk as never, kv as never);
    for (const sessionId of new Set(item.sessions)) await kv.set(KV.summaries, sessionId, { sessionId, title: sessionId, keyDecisions: [sessionId === "needed" ? decision : "Use the printed checklist."], createdAt: stamp, filesModified: [] });
    await kv.set(KV.lessons, "lesson", { id: "lesson", content: "Validate fixture parcel dispatch labels (fixture-lesson)", context: "parcel dispatch", project: "synthetic", confidence: 0.9, createdAt: stamp, tags: [] });
    sdk.registerFunction("mem::search", async (data) => {
      const args = data as { query: string; project: string };
      if (args.project !== "synthetic") throw new Error("Search lost project scope");
      return { results: args.query === prompt ? item.sessions.map((sessionId, i) => ({
        sessionId, score: 20 - i * 0.1,
        observation: { id: `obs-${i}`, timestamp: stamp, narrative: i === item.winningIndex ? "winning-evidence" : `ordinary-evidence-${i}` },
      })) : [] };
    });
    const priorRequests = requests;
    const start = performance.now();
    const result = await sdk.trigger("mem::prompt-context", { sessionId: "next", project: "synthetic", prompt }) as PromptContextResult;
    const ms = Math.round(performance.now() - start);
    if (requests !== priorRequests + 1) throw new Error("Trial did not send exactly one Gate request");
    const visible = result.context.includes(decision);
    return { visible, timely: visible && ms < INJECT_TIMEOUT_MS, ms, lessonVisible: result.context.includes("fixture-lesson"), pool };
  }
  try {
    return {
      crowded: { baseline: await render(registerPromptContextFunction, cases.crowded), treatment: await render(treatment, cases.crowded) },
      second: { baseline: await render(registerPromptContextFunction, cases.second), treatment: await render(treatment, cases.second) },
    };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((done) => server.close(() => done()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
