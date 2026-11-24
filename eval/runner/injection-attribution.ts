import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithTimeout } from "../../src/providers/_fetch.js";
import { appendDurable, startNdjson } from "./durable.js";
import { scoreAction } from "./outcome-ranking.js";

const tasks = [
  { id: "fit-rule", split: "dev", kind: "rule", broad: "No other decision is available.", memo: "Approved fixture palette: iris.", expected: "iris", stale: "iris" },
  { id: "fit-legacy", split: "dev", kind: "legacy", broad: "The palette is not yet approved.", memo: "Approved fixture palette: mint.", expected: "defer", stale: "mint" },
  { id: "probe-rule", split: "probe", kind: "rule", broad: "The current confirmed palette is rose.", memo: "Approved fixture palette: rose.", expected: "rose", stale: "rose" },
  { id: "probe-legacy", split: "probe", kind: "legacy", broad: "The current confirmed palette is jade.", memo: "Approved fixture palette: lime.", expected: "jade", stale: "lime" },
] as const;
const neutral = "Indexed fixture appendix: none.";
const seeds = [42, 43];

type Action = { kind: string; included: boolean; success: boolean };
export function learnPolicy(rows: Action[], kind: string) {
  return rows.filter((row) => row.kind === kind && row.success).reduce((n, row) => n + (row.included ? 1 : -1), 0) >= 0;
}

type Trial = Action & { id: string; split: string; seed: number; stale: boolean; rev: string; hash: string; promptTokens: number; ms: number; reply: string };
async function run() {
  const rev = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL("./outcome-ranking.ts", import.meta.url))).digest("hex");
  const output = "tmp/injection-attribution/trials.ndjson";
  mkdirSync("tmp/injection-attribution", { recursive: true });
  const rows = startNdjson<Trial>(output, process.argv.includes("--resume"));
  if (rows.some((row) => row.rev !== rev || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
  let order = 127;
  for (const task of tasks) {
    for (const seed of seeds) {
      order = (Math.imul(order, 1664525) + 1013904223) >>> 0;
      const first = order < 2 ** 31;
      for (const included of [first, !first]) {
        if (rows.some((row) => row.id === task.id && row.seed === seed && row.included === included)) continue;
        const start = performance.now();
        const response = await fetchWithTimeout("http://ai.lan:4010/v1/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "general-eval-b", temperature: 0, seed, max_tokens: 2048, stream: false,
            messages: [{ role: "user", content: `Set the fixture palette using an approved decision; defer when none is available. Return only {"value":"<palette or defer>"}.\nTask notes: ${task.broad}\nRecalled note: ${included ? task.memo : neutral}` }] }),
        }, 60_000);
        if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
        const body = await response.json() as { choices: { message: { content: string | null } }[]; usage: { prompt_tokens: number } };
        const reply = body.choices[0]?.message.content ?? "";
        const { success, stale } = scoreAction(reply, task.expected, task.stale);
        const result = { id: task.id, split: task.split, kind: task.kind, seed, included, success, stale, promptTokens: body.usage.prompt_tokens, ms: Math.round(performance.now() - start) };
        const row = { rev, hash, reply, ...result };
        appendDurable(output, row);
        rows.push(row);
        console.log(JSON.stringify(result));
      }
    }
  }
  const training = rows.filter((row) => row.split === "dev");
  const probe = rows.filter((row) => row.split === "probe");
  const policy = probe.filter((row) => row.included === learnPolicy(training, row.kind));
  console.log(JSON.stringify({ policy: Object.fromEntries(tasks.map(({ kind }) => [kind, learnPolicy(training, kind)])), baselineCorrect: probe.filter((row) => row.included && row.success).length, policyCorrect: policy.filter((row) => row.success).length }));
  console.log("DONE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
