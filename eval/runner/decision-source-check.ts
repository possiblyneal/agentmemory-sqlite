import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { appendDurable, startNdjson } from "./durable.js";

const cases = [
  { name: "value", key: "attempt_limit", draft: "8", expected: "4", source: "The first proposal was eight attempts. The Operator said: use four attempts, not eight. The Agent agreed to use four." },
  { name: "negation", key: "overwrite_existing", draft: "true", expected: "false", source: "The Operator said: never overwrite an existing fixture. The Agent will only generate new fixtures." },
  { name: "condition", key: "export_window", draft: "always", expected: "nightly", source: "The Operator said: export only on the nightly run. Manual and daytime scheduled runs must not export." },
  { name: "correct", key: "manifest_format", draft: "yaml", expected: "yaml", source: "The Agent proposed JSON. The Operator said to use YAML instead and confirmed YAML later." },
] as const;

const system = `Check the drafted decision against the source dialogue. Preserve exact values, negation and conditions, following the final Operator decision. Change at most one decision and only when the source contradicts the draft. Return only a JSON object with one field, "replacement". Use null if the draft is supported or the source does not settle the value. Otherwise use the corrected lowercase scalar as a string: decimal integer, true/false, or a single lowercase label. Do not add a decision.`;

type Trial = { revision: string; hash: string; name: string; baselineError: boolean; treatmentError: boolean; valid: boolean; ms: number; reply: string };
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
mkdirSync("tmp/decision-source-check", { recursive: true });
const output = "tmp/decision-source-check/trials.ndjson";
const rows = startNdjson<Trial>(output, process.argv.includes("--resume"));
if (rows.some((row) => row.revision !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
process.env.OPENAI_EXTRA_BODY = JSON.stringify({ temperature: 0, seed: 42 });
const provider = new OpenAIProvider("local", "general-eval-b", 2048, "http://ai.lan:4010/v1");

for (const { name, key, draft, expected, source } of cases) {
  if (rows.some((row) => row.name === name)) continue;
  const start = performance.now();
  const reply = await provider.summarize(system, `Source:\n${source}\n\nDrafted decision:\n${key} = ${draft}`);
  const ms = Math.round(performance.now() - start);
  let replacement: string | null | undefined;
  try {
    const value = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, unknown> | null;
    if (value && Object.keys(value).length === 1) {
      const candidate = value.replacement;
      if (candidate === null || (typeof candidate === "string" && /^[a-z0-9]+$/.test(candidate))) replacement = candidate;
    }
  } catch { /* A malformed reply leaves the draft unchanged. */ }
  const valid = replacement !== undefined;
  const baselineError = draft !== expected;
  const treatmentError = (replacement ?? draft) !== expected;
  const result = { name, baselineError, treatmentError, valid, ms };
  appendDurable(output, { revision, hash, ...result, reply });
  console.log(JSON.stringify(result));
}
console.log("DONE");
