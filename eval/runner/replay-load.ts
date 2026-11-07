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
  include?: ReadonlySet<string>;
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
      if (!session || seen.has(session.id)) continue;
      seen.add(session.id);
      if (!projectByCwd.has(session.cwd)) projectByCwd.set(session.cwd, repoProject(session.cwd, session.project));
      session.project = projectByCwd.get(session.cwd)!;
      byProject.set(session.project, [...(byProject.get(session.project) ?? []), session]);
    }
    perDirectory[dir] = stats;
  }
  const { sessions, perProject } = selectSessions([...byProject.values()].flat(), opts);
  return { sessions, perDirectory, perProject };
}

// Per project the earliest `cap` Sessions with `minTurns` turns; a Session in
// `include` is kept whatever either says, so every origin of the decision key
// is replayed.
export function selectSessions(
  sessions: ReplaySession[],
  opts: Pick<LoadOptions, "cap" | "minTurns" | "include">,
): Pick<Loaded, "sessions" | "perProject"> {
  const forced = (s: ReplaySession) => opts.include?.has(s.id) === true;
  const byProject = new Map<string, ReplaySession[]>();
  for (const s of sessions) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
  const picked: ReplaySession[] = [];
  const perProject: Loaded["perProject"] = {};
  for (const [project, all] of byProject) {
    const ordered = orderByStart(all);
    const normal = ordered.filter((s) => s.userTurns.length >= opts.minTurns);
    const chosen = new Set(normal.slice(0, opts.cap));
    for (const s of ordered) if (forced(s)) chosen.add(s);
    perProject[project] = { replayable: normal.length + ordered.filter((s) => forced(s) && s.userTurns.length < opts.minTurns).length, replayed: chosen.size };
    picked.push(...chosen);
  }
  return { sessions: orderByStart(picked), perProject };
}
