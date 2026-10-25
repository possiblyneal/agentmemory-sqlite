import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit } from "./audit.js";
import { storeAcceptsWrite } from "../health/store-probe.js";
import { readMissedInjections } from "../hooks/_missed-injection.js";
import { injectionGateState } from "./prompt-rerank.js";
import { inferMemoryProjects } from "./migrate.js";
import { loadProjectTime } from "../state/project-time.js";
import { injectedItemUse } from "./injections.js";
import type { AccessLog } from "./access-tracker.js";
import type {
  DiagnosticCheck,
  Insight,
  Lesson,
  ProceduralMemory,
  SemanticMemory,
  SessionSummary,
  Signal,
  MeshPeer,
  Session,
  Memory,
  CompressedObservation,
  InjectionRecord,
} from "../types.js";

export const ALL_CATEGORIES = [
  "signals",
  "sessions",
  "observations",
  "memories",
  "lessons",
  "summaries",
  "semantic",
  "procedural",
  "insights",
  "mesh",
  "injections",
  "injection-use",
  "recall-coverage",
];

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const UNRECALLED_GRACE_ACTIVE_WEEKS = 4;
const UNRECALLED_SAMPLE_SIZE = 5;
const UNUSED_INJECTION_WARN_SHARE = 0.5;
const UNUSED_INJECTION_MIN_ITEMS = 10;
// An Injection younger than this has not had a fair chance to be used yet.
const UNUSED_INJECTION_SETTLE_MS = ONE_HOUR_MS;

function lastActivity(session: Session): string {
  return session.updatedAt ?? session.startedAt;
}

// Judged by last activity, not start, so a long-running live Session is left alone.
function isAbandonedSession(session: Session, now: number): boolean {
  return (
    session.status === "active" &&
    now - new Date(lastActivity(session)).getTime() > TWENTY_FOUR_HOURS_MS
  );
}

// Past the grace window a raw record is a compression that never ran; inside
// it, compression may still be in flight.
function isStrandedRaw(o: Record<string, unknown>, now: number): boolean {
  if (typeof o["narrative"] === "string") return false;
  if (typeof o["hookType"] !== "string") return false;
  const ts = new Date(String(o["timestamp"])).getTime();
  return !(Number.isFinite(ts) && now - ts < ONE_HOUR_MS);
}

type SessionlessScope = {
  raw: number;
  compressed: number;
  // A Session Summary is the one surviving record that names the project.
  summaryNamesProject: boolean;
};

// Eviction deletes a Session record and keeps its Observations, and a host
// that never sends a session start leaves Observations with no Session at all.
async function sessionlessObservations(
  kv: StateKV,
  sessions: Session[],
  now: number,
): Promise<SessionlessScope[]> {
  const known = new Set(sessions.map((session) => session.id));
  const prefix = KV.observations("");
  const sessionIds = (await kv.listScopes(prefix))
    .map((scope) => scope.slice(prefix.length))
    .filter((sessionId) => !known.has(sessionId));
  return Promise.all(
    sessionIds.map(async (sessionId) => {
      const [observations, summary] = await Promise.all([
        kv.list<Record<string, unknown>>(KV.observations(sessionId)),
        kv.get<SessionSummary>(KV.summaries, sessionId),
      ]);
      const raw = observations.filter((o) => isStrandedRaw(o, now)).length;
      const compressed = observations.filter((o) => typeof o["narrative"] === "string").length;
      return { raw, compressed, summaryNamesProject: Boolean(summary?.project) };
    }),
  );
}

export function registerDiagnosticsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::diagnose", 
    async (data: { categories?: string[] }) => {
      const categories = data.categories && data.categories.length > 0
        ? data.categories.filter((c) => ALL_CATEGORIES.includes(c))
        : ALL_CATEGORIES;

      const checks: DiagnosticCheck[] = [];
      const now = Date.now();

      if (categories.includes("signals")) {
        const signals = await kv.list<Signal>(KV.signals);
        let signalIssues = 0;

        for (const signal of signals) {
          if (
            signal.expiresAt &&
            new Date(signal.expiresAt).getTime() <= now
          ) {
            checks.push({
              name: `expired-signal:${signal.id}`,
              category: "signals",
              status: "fail",
              message: `Signal from "${signal.from}" expired at ${signal.expiresAt}`,
              fixable: true,
            });
            signalIssues++;
          }
        }

        if (signalIssues === 0) {
          checks.push({
            name: "signals-ok",
            category: "signals",
            status: "pass",
            message: `All ${signals.length} signals are healthy`,
            fixable: false,
          });
        }
      }

      if (categories.includes("sessions")) {
        const writable = await storeAcceptsWrite(kv, "_diagnose_probe");
        checks.push({
          name: writable ? "store-writable" : "store-unwritable",
          category: "sessions",
          status: writable ? "pass" : "fail",
          message: writable
            ? "The store accepts writes"
            : "The store rejected a write or did not return it, so no new data is being saved.",
          fixable: false,
        });

        const sessions = await kv.list<Session>(KV.sessions);
        const abandoned = sessions.filter((session) => isAbandonedSession(session, now));

        if (abandoned.length > 0) {
          const examples = abandoned.slice(0, 3).map((session) => session.id).join(", ");
          checks.push({
            name: "abandoned-sessions",
            category: "sessions",
            status: "warn",
            message:
              `${abandoned.length} sessions are still active with no activity for over 24 hours ` +
              `(e.g. ${examples}). POST /agentmemory/diagnostics/heal ` +
              `{"categories":["sessions"]} closes them.`,
            fixable: true,
          });
        }

        if (sessions.length === 0) {
          checks.push({
            name: "sessions-empty",
            category: "sessions",
            status: "warn",
            message:
              "No sessions are recorded. A new install starts this way; otherwise the store " +
              "is pointed at the wrong file or its data was lost.",
            fixable: false,
          });
        } else if (abandoned.length === 0) {
          checks.push({
            name: "sessions-ok",
            category: "sessions",
            status: "pass",
            message: `All ${sessions.length} sessions are healthy`,
            fixable: false,
          });
        }
      }

      // Observations were the ONLY record type with no integrity check, and
      // they are the highest-volume one. A CompressedObservation always has a
      // narrative; a RawObservation never does. A record still in raw shape
      // means mem::compress failed and returned before storing, leaving it
      // present on disk but absent from BOTH search indexes - unretrievable,
      // and silent, because a recall miss cannot be observed from outside.
      // That is how the v0.1.0 orphaning defect ran undetected until
      // 2026-08-18 and accumulated 411 unreachable observations.
      if (categories.includes("observations")) {
        const sessions = await kv.list<Session>(KV.sessions);
        const orphaned: string[] = [];
        let total = 0;

        for (const session of sessions) {
          const observations = await kv.list<Record<string, unknown>>(
            KV.observations(session.id),
          );
          total += observations.length;
          for (const o of observations) {
            if (isStrandedRaw(o, now)) orphaned.push(String(o["id"] ?? "unknown"));
          }
        }

        if (orphaned.length > 0) {
          checks.push({
            name: `observations-uncompressed:${orphaned.length}`,
            category: "observations",
            status: "warn",
            message:
              `${orphaned.length} of ${total} observations are still in raw shape, so they are in neither ` +
              `the BM25 nor the vector index and no search can return them (e.g. ` +
              `${orphaned.slice(0, 5).join(", ")}). Re-run compression for these.`,
            fixable: false,
          });
        } else {
          checks.push({
            name: "observations-ok",
            category: "observations",
            status: "pass",
            message: `All ${total} Observations of known Sessions are compressed and indexable`,
            fixable: false,
          });
        }

        const sessionless = await sessionlessObservations(kv, sessions, now);
        const raw = (scopes: SessionlessScope[]) => scopes.reduce((n, scope) => n + scope.raw, 0);
        const namedRaw = raw(sessionless.filter((scope) => scope.summaryNamesProject));
        const unnamedRaw = raw(sessionless.filter((scope) => !scope.summaryNamesProject));
        const sessionlessCompressed = sessionless.reduce((n, scope) => n + scope.compressed, 0);

        if (sessionless.length > 0) {
          checks.push({
            name: `observations-sessionless:${sessionless.length}`,
            category: "observations",
            status: namedRaw + unnamedRaw > 0 ? "warn" : "pass",
            message:
              `${sessionless.length} Sessions have Observations but no Session record: ` +
              `${sessionlessCompressed} compressed, ${namedRaw} raw whose Session Summary names ` +
              `their project, and ${unnamedRaw} raw with neither a Session nor a Session Summary ` +
              `to name it. Raw ones are in neither search index.`,
            fixable: false,
          });
        }
      }

      if (categories.includes("memories")) {
        const memories = await kv.list<Memory>(KV.memories);
        const memoryIds = new Set(memories.map((m) => m.id));
        const supersededBy = new Map<string, string>();
        let memoryIssues = 0;

        for (const memory of memories) {
          if (memory.supersedes && memory.supersedes.length > 0) {
            for (const sid of memory.supersedes) {
              if (!memoryIds.has(sid)) {
                checks.push({
                  name: `memory-missing-supersedes:${memory.id}:${sid}`,
                  category: "memories",
                  status: "warn",
                  message: `Memory "${memory.title}" supersedes non-existent memory ${sid}`,
                  fixable: false,
                });
                memoryIssues++;
              }
              supersededBy.set(sid, memory.id);
            }
          }
        }

        for (const memory of memories) {
          if (memory.isLatest && supersededBy.has(memory.id)) {
            checks.push({
              name: `memory-stale-latest:${memory.id}`,
              category: "memories",
              status: "fail",
              message: `Memory "${memory.title}" has isLatest=true but is superseded by ${supersededBy.get(memory.id)}`,
              fixable: true,
            });
            memoryIssues++;
          }
        }

        // Project-coverage check: unscoped memories (no project field) will
        // appear in every project's context and search results until the
        // infer-memory-projects migration runs. Surface a count so operators
        // know the backfill is still pending and can trigger it explicitly.
        const latestMemories = memories.filter((m) => m.isLatest);
        const unscopedCount = latestMemories.filter((m) => !m.project && !m.global).length;
        if (unscopedCount === 0) {
          checks.push({
            name: "memory-project-coverage",
            category: "memories",
            status: "pass",
            message: `All ${latestMemories.length} latest memories have a project scope`,
            fixable: false,
          });
        } else {
          const { updated: resolvable, ambiguous } = await inferMemoryProjects(kv, true);
          const backfill =
            resolvable > 0
              ? ` — run POST /agentmemory/migrate {"step":"infer-memory-projects"} to backfill ${resolvable}`
              : "";
          const operator =
            ambiguous > 0
              ? `; ${ambiguous} cannot be resolved from their sessions and need the Operator to assign a project`
              : "";
          checks.push({
            name: "memory-project-coverage",
            category: "memories",
            status: unscopedCount <= 10 ? "warn" : "fail",
            message: `${unscopedCount} of ${latestMemories.length} latest memories have no project scope${backfill}${operator}`,
            fixable: resolvable > 0,
          });
        }

        if (memoryIssues === 0) {
          checks.push({
            name: "memories-ok",
            category: "memories",
            status: "pass",
            message: `All ${memories.length} memories are structurally consistent`,
            fixable: false,
          });
        }
      }

      if (categories.includes("lessons")) {
        // Catches bad confidence values that would silently break recall
        // scoring (memory_lesson_recall multiplies by confidence).
        const lessons = await kv.list<Lesson>(KV.lessons);
        let lessonIssues = 0;
        for (const l of lessons) {
          // Number.isFinite rejects NaN / Infinity / non-numbers; a
          // corrupted row passing those would silently survive the < / >
          // range check (e.g. NaN < 0 is false, NaN > 1 is false, so the
          // bad row would be "healthy") and skew memory_lesson_recall's
          // scoring downstream. Surface as warning.
          if (
            !Number.isFinite(l.confidence) ||
            l.confidence < 0 ||
            l.confidence > 1
          ) {
            checks.push({
              name: `lesson-bad-confidence:${l.id}`,
              category: "lessons",
              status: "warn",
              message: `Lesson ${l.id} has confidence ${l.confidence} (expected finite number in 0..1)`,
              fixable: false,
            });
            lessonIssues++;
          }
        }
        if (lessonIssues === 0) {
          checks.push({
            name: "lessons-ok",
            category: "lessons",
            status: "pass",
            message: `All ${lessons.length} lessons are healthy`,
            fixable: false,
          });
        }
      }

      if (categories.includes("summaries")) {
        const summaries = await kv.list<SessionSummary>(KV.summaries);
        let summaryIssues = 0;
        for (const s of summaries) {
          // typeof guard before .trim() — a corrupted row with title=null
          // or title=42 would otherwise throw and abort the whole diagnose
          // run before later categories get checked.
          if (typeof s.title !== "string" || s.title.trim().length === 0) {
            checks.push({
              name: `summary-missing-title:${s.sessionId}`,
              category: "summaries",
              status: "warn",
              message: `Summary for session ${s.sessionId} has no title`,
              fixable: false,
            });
            summaryIssues++;
          }
        }
        if (summaryIssues === 0) {
          checks.push({
            name: "summaries-ok",
            category: "summaries",
            status: "pass",
            message: `All ${summaries.length} session summaries are consistent`,
            fixable: false,
          });
        }
      }

      if (categories.includes("semantic")) {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        let semanticIssues = 0;
        for (const s of semantic) {
          if (
            !Number.isFinite(s.confidence) ||
            s.confidence < 0 ||
            s.confidence > 1
          ) {
            checks.push({
              name: `semantic-bad-confidence:${s.id}`,
              category: "semantic",
              status: "warn",
              message: `Semantic fact ${s.id} has confidence ${s.confidence} (expected finite number in 0..1)`,
              fixable: false,
            });
            semanticIssues++;
          }
        }
        if (semanticIssues === 0) {
          checks.push({
            name: "semantic-ok",
            category: "semantic",
            status: "pass",
            message: `All ${semantic.length} semantic memories are consistent`,
            fixable: false,
          });
        }
      }

      if (categories.includes("procedural")) {
        const procedural = await kv.list<ProceduralMemory>(KV.procedural);
        let proceduralIssues = 0;
        for (const p of procedural) {
          if (!Array.isArray(p.steps) || p.steps.length === 0) {
            checks.push({
              name: `procedural-empty-steps:${p.id}`,
              category: "procedural",
              status: "warn",
              message: `Procedural memory "${p.name}" (${p.id}) has no steps`,
              fixable: false,
            });
            proceduralIssues++;
          }
        }
        if (proceduralIssues === 0) {
          checks.push({
            name: "procedural-ok",
            category: "procedural",
            status: "pass",
            message: `All ${procedural.length} procedural memories are consistent`,
            fixable: false,
          });
        }
      }

      if (categories.includes("insights")) {
        const insights = await kv.list<Insight>(KV.insights);
        let insightIssues = 0;
        for (const i of insights) {
          if (
            !Number.isFinite(i.confidence) ||
            i.confidence < 0 ||
            i.confidence > 1
          ) {
            checks.push({
              name: `insight-bad-confidence:${i.id}`,
              category: "insights",
              status: "warn",
              message: `Insight ${i.id} has confidence ${i.confidence} (expected finite number in 0..1)`,
              fixable: false,
            });
            insightIssues++;
          }
        }
        if (insightIssues === 0) {
          checks.push({
            name: "insights-ok",
            category: "insights",
            status: "pass",
            message: `All ${insights.length} insights are consistent`,
            fixable: false,
          });
        }
      }

      if (categories.includes("mesh")) {
        const peers = await kv.list<MeshPeer>(KV.mesh);
        let meshIssues = 0;

        for (const peer of peers) {
          if (
            peer.lastSyncAt &&
            now - new Date(peer.lastSyncAt).getTime() > ONE_HOUR_MS
          ) {
            checks.push({
              name: `stale-peer:${peer.id}`,
              category: "mesh",
              status: "warn",
              message: `Peer "${peer.name}" last synced over 1 hour ago`,
              fixable: false,
            });
            meshIssues++;
          }

          if (peer.status === "error") {
            checks.push({
              name: `error-peer:${peer.id}`,
              category: "mesh",
              status: "warn",
              message: `Peer "${peer.name}" is in error state`,
              fixable: false,
            });
            meshIssues++;
          }
        }

        if (meshIssues === 0) {
          checks.push({
            name: "mesh-ok",
            category: "mesh",
            status: "pass",
            message: `All ${peers.length} mesh peers are healthy`,
            fixable: false,
          });
        }
      }

      if (categories.includes("injections")) {
        const recent = readMissedInjections().filter(
          (m) => now - new Date(m.at).getTime() <= TWENTY_FOUR_HOURS_MS,
        );
        if (recent.length === 0) {
          checks.push({
            name: "injections-ok",
            category: "injections",
            status: "pass",
            message: "No Missed Injections in the last 24h",
            fixable: false,
          });
        } else {
          const byHookAndReason = new Map<string, number>();
          for (const m of recent) {
            const key = `${m.hook}/${m.reason}`;
            byHookAndReason.set(key, (byHookAndReason.get(key) ?? 0) + 1);
          }
          const breakdown = [...byHookAndReason]
            .map(([key, count]) => `${key} ${count}`)
            .join(", ");
          checks.push({
            name: "missed-injections",
            category: "injections",
            status: "warn",
            message: `${recent.length} Missed Injections in the last 24h: ${breakdown}`,
            fixable: false,
          });
        }
      }

      if (categories.includes("injections")) {
        const gate = injectionGateState();
        const counts = `${gate.calls} calls, ${gate.fallbacks} fallbacks`;
        const failure = gate.lastFailure
          ? `, last failure ${gate.lastFailure.reason} at ${gate.lastFailure.at} (${gate.lastFailure.sinceBootSeconds}s since boot)`
          : "";
        checks.push({
          name: "injection-gate",
          category: "injections",
          status: gate.enabled && gate.failing ? "warn" : "pass",
          message: gate.enabled
            ? `Injection Gate on (${gate.url}): ${counts}${failure}`
            : "Injection Gate off: prompt-submit Injection is BM25-only",
          fixable: false,
        });
      }

      if (categories.includes("injection-use")) {
        const records = (await kv.list<InjectionRecord>(KV.injections)).filter((r) => {
          const age = now - Date.parse(r.at);
          return age >= UNUSED_INJECTION_SETTLE_MS && age <= TWENTY_FOUR_HOURS_MS && r.injected.length > 0;
        });
        const sessionIds = [...new Set(records.map((r) => r.sessionId))];
        const observationsBySession = new Map(
          await Promise.all(
            sessionIds.map(
              async (id) => [id, await kv.list<CompressedObservation>(KV.observations(id))] as const,
            ),
          ),
        );
        const bySource = new Map<string, { scored: number; unused: number }>();
        const total = { scored: 0, unused: 0 };
        for (const record of records) {
          const tally = bySource.get(record.source) ?? { scored: 0, unused: 0 };
          const observations = observationsBySession.get(record.sessionId) ?? [];
          for (const ref of record.injected) {
            const use = injectedItemUse(ref, record, observations);
            if (use === "unscorable") continue;
            for (const t of [tally, total]) {
              t.scored++;
              if (use === "unused") t.unused++;
            }
          }
          bySource.set(record.source, tally);
        }
        const share = (t: { scored: number; unused: number }) => Math.round((t.unused / t.scored) * 100);
        const breakdown = [...bySource]
          .filter(([, t]) => t.scored > 0)
          .map(([source, t]) => `${source} ${share(t)}% of ${t.scored}`)
          .join(", ");
        const tooUnused =
          total.scored >= UNUSED_INJECTION_MIN_ITEMS &&
          total.unused / total.scored > UNUSED_INJECTION_WARN_SHARE;
        const injectedItemsNote =
          total.scored === 0
            ? "No scorable injected items between 1h and 24h ago."
            : `${share(total)}% of ${total.scored} injected items unused between 1h and 24h ago (${breakdown}); ` +
              `warns above ${UNUSED_INJECTION_WARN_SHARE * 100}% once ${UNUSED_INJECTION_MIN_ITEMS} items are scored. ` +
              "This is a proxy: an item counts as used when a later Observation in the same Session touched one of its files or named it, " +
              "and items with no files are not scored.";
        checks.push({
          name: tooUnused ? "unused-injections" : "injection-use-ok",
          category: "injection-use",
          status: tooUnused ? "warn" : "pass",
          message: injectedItemsNote,
          fixable: false,
        });
      }

      if (categories.includes("recall-coverage")) {
        const [memories, accessLogs, activeWeeksSince] = await Promise.all([
          kv.list<Memory>(KV.memories),
          kv.list<AccessLog>(KV.accessLog),
          loadProjectTime(kv),
        ]);
        const recalled = new Set(accessLogs.filter((a) => a.count > 0).map((a) => a.memoryId));
        const nowIso = new Date(now).toISOString();
        const unrecalled = memories.filter(
          (m) =>
            m.isLatest !== false &&
            !recalled.has(m.id) &&
            activeWeeksSince(m.project, m.createdAt, nowIso) >= UNRECALLED_GRACE_ACTIVE_WEEKS,
        );
        if (unrecalled.length === 0) {
          checks.push({
            name: "recall-coverage-ok",
            category: "recall-coverage",
            status: "pass",
            message: "Every Memory past its grace period has been returned by a Recall",
            fixable: false,
          });
        } else {
          const noun = unrecalled.length === 1 ? "Unrecalled Memory" : "Unrecalled Memories";
          const sample = unrecalled
            .slice(0, UNRECALLED_SAMPLE_SIZE)
            .map((m) => `${m.id} (${m.title})`)
            .join(", ");
          checks.push({
            name: "unrecalled-memories",
            category: "recall-coverage",
            status: "warn",
            message: `${unrecalled.length} ${noun} past ${UNRECALLED_GRACE_ACTIVE_WEEKS} active weeks, e.g. ${sample}`,
            fixable: false,
          });
        }
      }

      const summary = {
        pass: checks.filter((c) => c.status === "pass").length,
        warn: checks.filter((c) => c.status === "warn").length,
        fail: checks.filter((c) => c.status === "fail").length,
        fixable: checks.filter((c) => c.fixable).length,
      };

      return { success: true, checks, summary };
    },
  );

  sdk.registerFunction("mem::heal", 
    async (data: { categories?: string[]; dryRun?: boolean }) => {
      const dryRun = data.dryRun ?? false;
      const categories = data.categories && data.categories.length > 0
        ? data.categories.filter((c) => ALL_CATEGORIES.includes(c))
        : ALL_CATEGORIES;

      let fixed = 0;
      let skipped = 0;
      const details: string[] = [];
      const now = Date.now();

      if (categories.includes("sessions")) {
        const sessions = await kv.list<Session>(KV.sessions);

        for (const session of sessions) {
          if (!isAbandonedSession(session, now)) continue;
          if (dryRun) {
            details.push(`[dry-run] Would close abandoned session ${session.id}`);
            fixed++;
            continue;
          }
          const didFix = await withKeyedLock(`obs:${session.id}`, async () => {
            const fresh = await kv.get<Session>(KV.sessions, session.id);
            if (!fresh || !isAbandonedSession(fresh, Date.now())) return false;
            await kv.update(KV.sessions, fresh.id, [
              { type: "set", path: "status", value: "abandoned" },
              { type: "set", path: "endedAt", value: lastActivity(fresh) },
            ]);
            await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
              entityType: "session",
              reason: "abandoned-session",
              newStatus: "abandoned",
            });
            return true;
          });
          if (didFix) {
            details.push(`Closed abandoned session ${session.id}`);
            fixed++;
          } else {
            skipped++;
          }
        }
      }

      if (categories.includes("signals")) {
        const signals = await kv.list<Signal>(KV.signals);

        for (const signal of signals) {
          if (
            signal.expiresAt &&
            new Date(signal.expiresAt).getTime() <= now
          ) {
            if (dryRun) {
              details.push(
                `[dry-run] Would delete expired signal ${signal.id}`,
              );
              fixed++;
              continue;
            }
            await kv.delete(KV.signals, signal.id);
            await recordAudit(kv, "heal", "mem::heal", [signal.id], {
              entityType: "signal",
              reason: "expired-signal",
              action: "delete",
            });
            details.push(`Deleted expired signal ${signal.id}`);
            fixed++;
          }
        }
      }

      if (categories.includes("memories")) {
        const memories = await kv.list<Memory>(KV.memories);
        const supersededBy = new Map<string, string>();

        for (const memory of memories) {
          if (memory.supersedes && memory.supersedes.length > 0) {
            for (const sid of memory.supersedes) {
              supersededBy.set(sid, memory.id);
            }
          }
        }

        for (const memory of memories) {
          if (memory.isLatest && supersededBy.has(memory.id)) {
            if (dryRun) {
              details.push(
                `[dry-run] Would set isLatest=false on memory "${memory.title}" (${memory.id})`,
              );
              fixed++;
              continue;
            }
            const didFix = await withKeyedLock(
              `mem:memory:${memory.id}`,
              async () => {
                const fresh = await kv.get<Memory>(KV.memories, memory.id);
                if (!fresh || !fresh.isLatest) return false;
                fresh.isLatest = false;
                fresh.updatedAt = new Date().toISOString();
                await kv.set(KV.memories, fresh.id, fresh);
                await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
                  entityType: "memory",
                  reason: "superseded-memory-mark-non-latest",
                  action: "update",
                });
                return true;
              },
            );
            if (didFix) {
              details.push(
                `Set isLatest=false on memory "${memory.title}" (${memory.id})`,
              );
              fixed++;
            } else {
              skipped++;
            }
          }
        }
      }

      return { success: true, fixed, skipped, details };
    },
  );
}
