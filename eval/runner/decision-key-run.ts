import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { operatorInputs } from "./decision-inputs.js";
import { buildDecisionKey, keyedSessionIds, loadOrBuildKey, unreachableOrigins, unreachableWarning } from "./decision-key.js";
import { DECISION_KEY_PATH, providerComplete } from "./decision-llm.js";
import { loadSessions } from "./replay-load.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      projects: { type: "string" },
      root: { type: "string", default: join(homedir(), ".claude/projects") },
      cap: { type: "string", default: "40" },
      "min-turns": { type: "string", default: "2" },
      rebuild: { type: "boolean", default: false },
    },
  });
  const projects = (values.projects ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const cap = Number(values.cap);
  const minTurns = Number(values["min-turns"]);
  if (projects.length === 0 || !Number.isInteger(cap) || cap < 1 || !Number.isInteger(minTurns) || minTurns < 1) {
    console.error("usage: eval:decision-key --projects=<dir>,... [--root DIR] [--cap N] [--min-turns N] [--rebuild]");
    process.exit(2);
  }
  const loadOpts = { projects, root: resolve(values.root as string), cap, minTurns };
  const { sessions } = loadSessions(loadOpts);
  const { key, reused } = await loadOrBuildKey(DECISION_KEY_PATH, values.rebuild === true, () => {
    const complete = providerComplete();
    console.log(`building the decision key from ${sessions.length} Sessions`);
    const entries = sessions.map((session) => ({ session, inputs: operatorInputs(readFileSync(session.sourcePath!, "utf8"), session) }));
    return buildDecisionKey(entries, complete);
  });
  const replayable = loadSessions({ ...loadOpts, include: keyedSessionIds(key) }).sessions;
  const warning = unreachableWarning(unreachableOrigins(key, new Set(replayable.map((s) => s.id))));
  if (warning) console.error(`warning: ${warning}`);
  console.log(
    `${reused ? "reused" : "wrote"} ${DECISION_KEY_PATH}: ${key.decisions.length} decisions, ` +
      `${key.expected.length} prompts with expected decisions, ${key.expected.reduce((n, e) => n + e.decisionIds.length, 0)} items`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
