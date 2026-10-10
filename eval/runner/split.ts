import { createHash } from "node:crypto";

export type Split = "dev" | "holdout";

// Changing the salt or the share reshuffles every benchmark, and the new
// holdout would hold items that were already tuned on.
const SALT = "agentmemory-eval-split-v1";
const HOLDOUT_SHARE = 0.4;

// Set by `eval:suite --holdout` after it logs the look; a runner refuses the
// holdout without it, so every look goes through the ledger.
export const HOLDOUT_ENV = "AGENTMEMORY_EVAL_HOLDOUT";

function rank(bench: string, id: string): string {
  return createHash("sha256").update(`${SALT}:${bench}:${id}`).digest("hex");
}

// Within each group the lowest-ranked share is the holdout, so a small group
// (three session-start questions) still lands on both sides, and adding an
// item moves at most one other across the line.
export function selectSplit<T>(
  bench: string,
  items: T[],
  split: Split | undefined,
  idOf: (item: T) => string,
  groupOf: (item: T) => string,
): T[] {
  if (!split) return items;
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);
  const holdout = new Set<string>();
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => rank(bench, idOf(a)).localeCompare(rank(bench, idOf(b))));
    for (const item of ordered.slice(0, Math.round(members.length * HOLDOUT_SHARE))) holdout.add(idOf(item));
  }
  return items.filter((item) => holdout.has(idOf(item)) === (split === "holdout"));
}

export function parseSplit(value: string | undefined): Split | undefined {
  if (value === undefined) return undefined;
  if (value !== "dev" && value !== "holdout") throw new Error(`--split must be dev or holdout, got: ${value}`);
  if (value === "holdout" && process.env[HOLDOUT_ENV] !== "1") {
    throw new Error("the holdout is sealed; run it through `npm run eval:suite -- --holdout`, which logs the look");
  }
  return value;
}
