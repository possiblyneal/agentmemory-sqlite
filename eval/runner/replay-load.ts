import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMainTranscriptName, orderByStart, parseTranscript, type ReplaySession } from "./replay-transcript.js";

const MAX_TRANSCRIPT_BYTES = 20_000_000;

export interface LoadOptions {
  projects: string[];
  root: string;
  cap: number;
  minTurns: number;
}

export interface Loaded {
  sessions: ReplaySession[];
  perDirectory: Record<string, { files: number; skippedLarge: number }>;
  perProject: Record<string, { replayable: number; replayed: number }>;
}

function mainCheckoutName(dir: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return basename(common) === ".git" ? basename(dirname(common)) : undefined;
  } catch {
    return undefined;
  }
}

// Mirrors the live hooks' resolveProject: every worktree of a repo files
// under its main checkout's name. A deleted worktree resolves from its
// nearest surviving ancestor inside the repo, or from the Orca layout
// <...>/workspaces/<repo>/<worktree>; anything else keeps the importer's name.
function repoProject(cwd: string, importerName: string): string {
  let dir = cwd;
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  return mainCheckoutName(dir) ?? cwd.match(/\/workspaces\/([^/]+)\/[^/]+/)?.[1] ?? importerName;
}

export function loadSessions(opts: LoadOptions): Loaded {
  const byProject = new Map<string, ReplaySession[]>();
  const perDirectory: Loaded["perDirectory"] = {};
  const projectByCwd = new Map<string, string>();
  const seen = new Set<string>();
  for (const dir of opts.projects) {
    const path = join(opts.root, dir);
    if (!existsSync(path)) {
      console.error(`no such project directory: ${path}`);
      process.exit(2);
    }
    const files = readdirSync(path).filter(isMainTranscriptName);
    const stats = { files: files.length, skippedLarge: 0 };
    for (const name of files) {
      const file = join(path, name);
      if (statSync(file).size > MAX_TRANSCRIPT_BYTES) {
        stats.skippedLarge++;
        continue;
      }
      const session = parseTranscript(readFileSync(file, "utf8"), file);
      if (!session || session.userTurns.length < opts.minTurns || seen.has(session.id)) continue;
      seen.add(session.id);
      if (!projectByCwd.has(session.cwd)) projectByCwd.set(session.cwd, repoProject(session.cwd, session.project));
      session.project = projectByCwd.get(session.cwd)!;
      byProject.set(session.project, [...(byProject.get(session.project) ?? []), session]);
    }
    perDirectory[dir] = stats;
  }
  const picked: ReplaySession[] = [];
  const perProject: Loaded["perProject"] = {};
  for (const [project, sessions] of byProject) {
    const chosen = orderByStart(sessions).slice(0, opts.cap);
    perProject[project] = { replayable: sessions.length, replayed: chosen.length };
    picked.push(...chosen);
  }
  return { sessions: orderByStart(picked), perDirectory, perProject };
}
