import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, Session } from "../types.js";

const run = promisify(execFile);

export async function checkoutRootsOf(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"], {
      cwd,
      timeout: 5000,
    });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  } catch {
    return [];
  }
}

async function checkoutRoots(
  kv: StateKV,
  observations: CompressedObservation[],
): Promise<string[]> {
  const sessionIds = new Set(observations.map((o) => o.sessionId).filter(Boolean));
  const sessions = await Promise.all(
    [...sessionIds].map((id) => kv.get<Session>(KV.sessions, id)),
  );
  const cwds = new Set(sessions.flatMap((s) => (s?.cwd ? [s.cwd] : [])));
  const roots = await Promise.all([...cwds].map(checkoutRootsOf));
  return [...new Set(roots.flat())];
}

export function projectRelative(file: string, roots: string[]): string {
  if (!isAbsolute(file)) return file;
  const path = resolve(file);
  let best: string | undefined;
  for (const root of roots) {
    if (path.startsWith(root + sep) && (!best || root.length > best.length)) best = root;
  }
  return best ? relative(best, path) : file;
}

export async function withProjectRelativeFiles(
  kv: StateKV,
  observations: CompressedObservation[],
): Promise<CompressedObservation[]> {
  const roots = await checkoutRoots(kv, observations);
  if (roots.length === 0) return observations;
  return observations.map((o) => ({
    ...o,
    files: (o.files ?? []).map((f) => projectRelative(f, roots)),
  }));
}
