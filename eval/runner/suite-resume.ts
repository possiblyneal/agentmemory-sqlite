import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunIdentity {
  commit: string;
  dirty: boolean;
  config: Record<string, string>;
}

// A resumed run keeps benches the earlier run finished, so it must be the same
// run: the same commit, tree state and Recall config.
export function resumeMismatch(dir: string, current: RunIdentity): string[] {
  const path = join(dir, "meta.json");
  if (!existsSync(path)) return [];
  const prior = JSON.parse(readFileSync(path, "utf8")) as RunIdentity;
  const diffs: string[] = [];
  if (prior.commit !== current.commit) diffs.push(`commit: earlier run ${prior.commit}, this run ${current.commit}`);
  if (prior.dirty !== current.dirty) diffs.push(`dirty: earlier run ${prior.dirty}, this run ${current.dirty}`);
  const keys = new Set([...Object.keys(prior.config), ...Object.keys(current.config)]);
  for (const key of [...keys].sort()) {
    if (prior.config[key] !== current.config[key]) diffs.push(`${key}: earlier run ${prior.config[key] ?? "unset"}, this run ${current.config[key] ?? "unset"}`);
  }
  return diffs;
}
