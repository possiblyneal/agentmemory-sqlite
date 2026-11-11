// Moves Lessons saved under a project no Session uses (#377) to the project
// their repo's Sessions use, and global Lessons to the one project their tags
// name. A Lesson whose project has no Session and no mapping is listed, not moved.
//
// Usage (dry run by default; --apply writes through POST /agentmemory/import):
//   npx tsx scripts/repair-lesson-projects.ts [--apply]
//   npx tsx scripts/repair-lesson-projects.ts --db <copy of the store>   (dry run only)
// AGENTMEMORY_URL (default http://localhost:3111) and AGENTMEMORY_SECRET pick the daemon.

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { KV } from "../src/state/schema.js";
import type { Lesson, Session } from "../src/types.js";
import { VERSION } from "../src/version.js";

export const RENAMES: Readonly<Record<string, string>> = {
  "nanokvm-boot-lab": "nanokvm-boot-lab-0c7806",
  "awesome-explorer": "awesome-explorer-060a65",
  "reverse-engineer": "reverse-engineering",
  compass: "compass-26f740",
  makara: "glydr",
  harlequin: "reverse-engineering",
  cisco: "medical-researcher",
};

export type Move = { lesson: Lesson; from: string | null; to: string };
export type RepairPlan = { moves: Move[]; unplaced: Lesson[] };

export function planLessonRepair(lessons: Lesson[], sessionProjects: Set<string>): RepairPlan {
  const moves: Move[] = [];
  const unplaced: Lesson[] = [];
  for (const lesson of lessons) {
    if (lesson.deleted) continue;
    const from = lesson.project ?? null;
    if (from !== null && sessionProjects.has(from)) continue;
    const to = from === null ? onlyTaggedProject(lesson, sessionProjects) : RENAMES[from];
    if (to !== undefined && sessionProjects.has(to)) moves.push({ lesson, from, to });
    else unplaced.push(lesson);
  }
  return { moves, unplaced };
}

function onlyTaggedProject(lesson: Lesson, sessionProjects: Set<string>): string | undefined {
  const named = new Set(lesson.tags.filter((tag) => sessionProjects.has(tag)));
  return named.size === 1 ? [...named][0] : undefined;
}

export function formatPlan(plan: RepairPlan): string {
  const head = (l: Lesson) => l.content.replace(/\s+/g, " ").slice(0, 70);
  const lines = [`Move (${plan.moves.length}):`];
  for (const m of plan.moves) {
    lines.push(`  ${m.lesson.id}  ${m.from ?? "(global)"} -> ${m.to}  ${head(m.lesson)}`);
  }
  lines.push(`Unplaced, left as they are (${plan.unplaced.length}):`);
  for (const l of plan.unplaced) lines.push(`  ${l.id}  ${l.project ?? "(global)"}  ${head(l)}`);
  return lines.join("\n");
}

function readStoreFile(path: string): { lessons: Lesson[]; sessions: Session[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  const scope = (name: string) =>
    db
      .prepare("SELECT value FROM kv WHERE scope = ?")
      .all(name)
      .map((row) => JSON.parse(String(row["value"])));
  const store = { lessons: scope(KV.lessons) as Lesson[], sessions: scope(KV.sessions) as Session[] };
  db.close();
  return store;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dbAt = process.argv.indexOf("--db");
  const dbPath = dbAt === -1 ? undefined : process.argv[dbAt + 1];
  if (dbAt !== -1 && !dbPath) throw new Error("--db needs a path");
  if (dbPath && apply) throw new Error("--db is a dry run; --apply writes through the daemon");
  const base = process.env["AGENTMEMORY_URL"] ?? "http://localhost:3111";
  const secret = process.env["AGENTMEMORY_SECRET"];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;

  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}/agentmemory${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };

  const { lessons, sessions } = dbPath
    ? readStoreFile(dbPath)
    : await Promise.all([
        call<{ lessons: Lesson[] }>("/lessons?limit=1000000"),
        call<{ sessions: Session[] }>("/sessions?limit=all"),
      ]).then(([l, s]) => ({ lessons: l.lessons, sessions: s.sessions }));
  const sessionProjects = new Set(sessions.map((s) => s.project).filter(Boolean));
  const plan = planLessonRepair(lessons, sessionProjects);
  console.log(formatPlan(plan));

  if (!apply) {
    console.log("Dry run: nothing written. Rerun with --apply to move the Lessons above.");
    return;
  }
  // updatedAt stays: session start ranks a Lesson's recency by it.
  const moved = plan.moves.map((m) => ({ ...m.lesson, project: m.to }));
  const result = await call("/import", {
    exportData: { version: VERSION, sessions: [], memories: [], summaries: [], observations: {}, lessons: moved },
    strategy: "merge",
  });
  console.log(`Applied: ${JSON.stringify(result)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
