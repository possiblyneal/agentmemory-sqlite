import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { appendDurable, startNdjson } from "./durable.js";

const cases = [
  { path: "catalog/title.txt", initial: "Parcel Catalog\n", task: "Rename the catalog to Winter Catalog.", lesson: "This loader requires ASCII uppercase letters for the entire catalog title. Render Winter Catalog as WINTER CATALOG.", wanted: /winter catalog/i, valid: /^WINTER CATALOG\n?$/ },
  { path: "archive/windows.ini", initial: "retention=45\n", task: "Change archive retention to 60 days.", lesson: "Retention is stored as a triple-digit number of days with leading zeroes. Encode 60 days as 060.", wanted: /^retention=0*60\n?$/, valid: /^retention=060\n?$/ },
  { path: "labels/parcel.txt", initial: "allow\n", task: "Change the parcel label status to HOLD.", lesson: "The legacy importer accepts only lowercase status literals. Encode HOLD as hold.", wanted: /^hold\n?$/i, valid: /^hold\n?$/ },
];
const arms = ["startup", "just-in-time", "none"] as const;
const system = "Make one edit to the exact target file. Return only a JSON object with a proposed first edit: {\"path\":\"exact path\",\"content\":\"complete new file content\"}. You cannot edit other paths. Do not describe the edit.";
const preload = "Repository tour: the invoice fixtures and sample receipts were checked. The maintainers prefer concise test logs. The demo dataset uses green divider lines; mock print jobs are generated under samples. Yesterday's task updated the shipping table. No other known project facts apply to the next task.";

// Pre-measure rule: fewer first-edit violations than both controls and no higher aggregate call time than either.
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const dir = resolve("tmp/first-edit-lesson");
mkdirSync(dir, { recursive: true });
const output = resolve(dir, "edits.ndjson");
const rows = startNdjson<{ revision: string; hash: string; path: string; arm: string }>(output, process.argv.includes("--resume"));
if (rows.some((row) => row.revision !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
process.env.OPENAI_EXTRA_BODY = JSON.stringify({ temperature: 0, seed: 42 });
const provider = new OpenAIProvider("local", "general-eval-b", 2048, "http://ai.lan:4010/v1");

for (const [i, item] of cases.entries()) {
  for (let j = 0; j < arms.length; j++) {
    const arm = arms[(i + j) % arms.length]!;
    if (rows.some((row) => row.path === item.path && row.arm === arm)) continue;
    const inject = `Lesson scoped to ${item.path}: ${item.lesson}`;
    const prompt = [
      "Session start", arm === "startup" ? inject : "", preload,
      "Current task", `${item.task} Target: ${item.path}.`, `Existing file: ${JSON.stringify(item.initial)}`,
      arm === "just-in-time" ? inject : "", "Make the first edit now.",
    ].filter(Boolean).join("\n");
    const start = performance.now();
    const reply = await provider.summarize(system, prompt);
    const elapsedMs = Math.round(performance.now() - start);
    let edit: { path?: unknown; content?: unknown } | null = null;
    try {
      edit = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch { /* Invalid proposals count as failures, not independent edits. */ }
    const usable = edit?.path === item.path && typeof edit.content === "string" && item.wanted.test(edit.content);
    const violation = !usable || !item.valid.test(edit!.content as string);
    appendDurable(output, { revision, hash, path: item.path, arm, usable, violation, elapsedMs, reply });
    console.log(`${item.path}: ${arm} usable=${usable} violation=${violation} elapsedMs=${elapsedMs}`);
  }
}
console.log("DONE");
