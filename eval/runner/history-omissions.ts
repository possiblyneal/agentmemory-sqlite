import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithTimeout } from "../../src/providers/_fetch.js";
import { appendDurable, startNdjson } from "./durable.js";
import { scoreAction } from "./outcome-ranking.js";

type Event = { at: number; project: string; kind: "approval" | "proposal"; text: string };
function eligible(events: Event[], project: string, turn: number) {
  return events.filter(event => event.project === project && event.at < turn);
}
export function retainApprovals(events: Event[], project: string, turn: number) {
  return eligible(events, project, turn).filter(event => event.kind === "approval").map(event => event.text).join("\n");
}
const event = (at: number, kind: Event["kind"], text: string, project = "fixture"): Event => ({ at, kind, text, project });
const tasks = [
  { id: "dev-palette", split: "dev", action: "Set the palette", compact: "Palette meeting finished; candidate is mint.", expected: "iris", stale: "mint", events: [event(1, "proposal", "Proposed palette: mint."), event(2, "approval", "Approved palette: iris.")] },
  { id: "dev-suffix", split: "dev", action: "Set the file suffix", compact: "Discussed a file suffix. Nothing approved.", expected: "defer", stale: "beta", events: [event(1, "proposal", "Proposed suffix: beta.")] },
  { id: "probe-region", split: "probe", action: "Set the fixture region", compact: "Fixture region selection completed.", expected: "north", stale: "south", events: [event(1, "proposal", "Proposed region: south."), event(2, "approval", "Approved region: north."), event(5, "approval", "Approved region: south.")] },
  { id: "probe-folder", split: "probe", action: "Set the catalog folder", compact: "Archive folder was discussed; old name was store.", expected: "shelf", stale: "store", events: [event(1, "proposal", "Candidate folder: store."), event(2, "approval", "Approved folder: shelf."), event(3, "approval", "Approved folder: store.", "other")] },
  { id: "probe-prefix", split: "probe", action: "Set the fixture prefix", compact: "No fixture prefix was approved.", expected: "defer", stale: "demo", events: [event(1, "proposal", "Potential prefix: demo."), event(5, "approval", "Approved prefix: demo.")] },
] as const;

type Arm = "compact" | "full" | "retained";
type Trial = { id: string; arm: Arm; rev: string; hash: string; success: boolean; stale: boolean; promptTokens: number; completionTokens: number; ms: number; reply: string };
async function run() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const hash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL("./outcome-ranking.ts", import.meta.url))).digest("hex");
  const output = "tmp/history-omissions/trials.ndjson";
  mkdirSync("tmp/history-omissions", { recursive: true });
  const rows = startNdjson<Trial>(output, process.argv.includes("--resume"));
  if (rows.some(row => row.rev !== revision || row.hash !== hash)) throw new Error("Saved trials use a different baseline or runner");
  for (const [index, task] of tasks.entries()) {
    const evidence = [...task.events];
    const full = eligible(evidence, "fixture", 4).map(row => row.text).join("\n");
    const retain = tasks.filter(item => item.split === "dev").some(item =>
      rows.some(row => row.id === item.id && row.arm === "full" && row.success) &&
      rows.some(row => row.id === item.id && row.arm === "compact" && !row.success) &&
      retainApprovals([...item.events], "fixture", 4));
    const arms: Arm[] = task.split === "dev" ? ["compact", "full"] : ["compact", "full", "retained"];
    const shift = index % arms.length;
    for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) {
      if (rows.some(row => row.id === task.id && row.arm === arm)) continue;
      const approvals = retain ? retainApprovals(evidence, "fixture", 4) : "";
      const notes = arm === "full" ? full : arm === "retained" && approvals ? `${task.compact}\n${approvals}` : task.compact;
      const start = performance.now();
      const response = await fetchWithTimeout("http://ai.lan:4010/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "general-eval-b", temperature: 0, seed: 42, max_tokens: 2048, stream: false,
          messages: [{ role: "user", content: `${task.action} using an approved decision; defer when none is available. Return only {"value":"<setting or defer>"}.\nProject notes:\n${notes}` }] }),
      }, 60_000);
      if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
      const body = await response.json() as { choices: { message: { content: string | null } }[]; usage: { prompt_tokens: number; completion_tokens: number } };
      const reply = body.choices[0]?.message.content ?? "";
      const row = { id: task.id, arm, rev: revision, hash, reply, ...scoreAction(reply, task.expected, task.stale),
        promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens, ms: Math.round(performance.now() - start) };
      appendDurable(output, row);
      rows.push(row);
      console.log(JSON.stringify({ id: row.id, arm, success: row.success, ms: row.ms }));
    }
  }
  console.log("DONE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
