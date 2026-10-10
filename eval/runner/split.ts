import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `all` scores the holdout too, so it is sealed and logged like `holdout`.
export type Split = "dev" | "holdout" | "all";

// Changing the salt or the share reshuffles every benchmark, and the new
// holdout would hold items that were already tuned on.
const SALT = "agentmemory-eval-split-v1";
const HOLDOUT_SHARE = 0.4;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const HOLDOUT_LEDGER = join(REPO_ROOT, "eval/holdout-ledger.ndjson");

// Names the look; a runner refuses the holdout without it, and logs the name
// in the ledger before it scores anything, so a look that crashes still counts.
export const HOLDOUT_ENV = "AGENTMEMORY_EVAL_HOLDOUT";

function rank(bench: string, id: string): string {
  return createHash("sha256").update(`${SALT}:${bench}:${id}`).digest("hex");
}

// Within each group the lowest-ranked share is the holdout, so any group of
// two or more (three session-start questions) lands on both sides, and adding
// an item moves at most one other across the line.
export function selectSplit<T>(
  bench: string,
  items: T[],
  split: Split | undefined,
  idOf: (item: T) => string,
  groupOf: (item: T) => string,
): T[] {
  if (!split || split === "all") return items;
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);
  const holdout = new Set<string>();
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => rank(bench, idOf(a)).localeCompare(rank(bench, idOf(b))));
    for (const item of ordered.slice(0, Math.round(members.length * HOLDOUT_SHARE))) holdout.add(idOf(item));
  }
  return items.filter((item) => holdout.has(idOf(item)) === (split === "holdout"));
}

export function parseSplit(value: string | undefined, bench: string, ledger = HOLDOUT_LEDGER): Split {
  const split = value ?? "dev";
  if (split !== "dev" && split !== "holdout" && split !== "all") {
    throw new Error(`--split must be dev, holdout or all, got: ${split}`);
  }
  if (split === "dev") return split;
  const label = process.env[HOLDOUT_ENV];
  if (!label) {
    throw new Error(
      `the holdout is sealed; run it through \`npm run eval:suite -- --holdout\`, or set ${HOLDOUT_ENV}=<why> to log a one-off look`,
    );
  }
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), bench, split, label, commit })}\n`);
  return split;
}
