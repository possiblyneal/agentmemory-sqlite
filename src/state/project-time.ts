import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { withKeyedLock } from "./keyed-mutex.js";
import type { ProjectActivity, Session, SessionSummary, StateScope } from "../types.js";

// Project Time (CONTEXT.md): a week counts only when the project had a
// Session in it. Weeks are UTC calendar weeks named by their Monday, and the
// record lives in its own scope so Eviction of Sessions cannot erase it.

const BACKFILLED_AT_KEY: keyof StateScope = "system:projectActivityBackfilledAt";

export type ActiveWeeksSince = (
  project: string | undefined,
  baselineIso: string,
  nowIso: string,
) => number;

function weekOf(iso: string): string | undefined {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  const daysSinceMonday = (t.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - daysSinceMonday),
  )
    .toISOString()
    .slice(0, 10);
}

async function addActiveWeeks(kv: StateKV, project: string, weeks: Iterable<string>): Promise<void> {
  await withKeyedLock(`project-activity:${project}`, async () => {
    const existing = await kv.get<ProjectActivity>(KV.projectActivity, project);
    const merged = new Set([...(existing?.weeks ?? []), ...weeks]);
    if (existing && merged.size === existing.weeks.length) return;
    await kv.set<ProjectActivity>(KV.projectActivity, project, {
      project,
      weeks: [...merged].sort(),
    });
  });
}

export async function recordProjectActivity(kv: StateKV, project: string, startedAt: string): Promise<void> {
  const week = weekOf(startedAt);
  if (week) await addActiveWeeks(kv, project, [week]);
}

async function backfillOnce(kv: StateKV): Promise<void> {
  if (await kv.get<number>(KV.state, BACKFILLED_AT_KEY)) return;
  const [sessions, summaries] = await Promise.all([
    kv.list<Session>(KV.sessions),
    kv.list<SessionSummary>(KV.summaries),
  ]);
  const weeksByProject = new Map<string, Set<string>>();
  const starts = [
    ...sessions.map((s) => [s.project, s.startedAt] as const),
    ...summaries.map((s) => [s.project, s.createdAt] as const),
  ];
  for (const [project, at] of starts) {
    const week = project && at ? weekOf(at) : undefined;
    if (!week) continue;
    if (!weeksByProject.has(project)) weeksByProject.set(project, new Set());
    weeksByProject.get(project)!.add(week);
  }
  await Promise.all(
    [...weeksByProject].map(([project, weeks]) => addActiveWeeks(kv, project, weeks)),
  );
  await kv.set<number>(KV.state, BACKFILLED_AT_KEY, Date.now());
}

export async function loadProjectTime(kv: StateKV): Promise<ActiveWeeksSince> {
  await backfillOnce(kv);
  const records = await kv.list<ProjectActivity>(KV.projectActivity);
  const weeksByProject = new Map(records.map((r) => [r.project, r.weeks]));
  const anyProjectWeeks = [...new Set(records.flatMap((r) => r.weeks))];
  return (project, baselineIso, nowIso) => {
    const from = weekOf(baselineIso);
    const to = weekOf(nowIso);
    if (!from || !to) return 0;
    const weeks = project ? (weeksByProject.get(project) ?? []) : anyProjectWeeks;
    return weeks.filter((w) => w > from && w <= to).length;
  };
}
