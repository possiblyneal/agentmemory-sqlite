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
import { injectedItemUse, resolveInsightFiles, withFiles } from "./injections.js";
import type { AccessLog } from "./access-tracker.js";
import type {
  Action,
  ActionEdge,
  DiagnosticCheck,
  Insight,
  Lease,
  Lesson,
  Crystal,
  ProceduralMemory,
  SemanticMemory,
  SessionSummary,
  Signal,
  Sentinel,
  Sketch,
  MeshPeer,
  Session,
  Memory,
  CompressedObservation,
  InjectionRecord,
} from "../types.js";

export const ALL_CATEGORIES = [
  "actions",
  "leases",
  "sentinels",
  "sketches",
  "signals",
  "sessions",
  "observations",
  "memories",
  "lessons",
  "summaries",
  "semantic",
  "procedural",
  "crystals",
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

      if (categories.includes("actions")) {
        const actions = await kv.list<Action>(KV.actions);
        const allEdges = await kv.list<ActionEdge>(KV.actionEdges);
        const leases = await kv.list<Lease>(KV.leases);
        const actionMap = new Map(actions.map((a) => [a.id, a]));

        for (const action of actions) {
          if (action.status === "active") {
            const hasActiveLease = leases.some(
              (l) =>
                l.actionId === action.id &&
                l.status === "active" &&
                new Date(l.expiresAt).getTime() > now,
            );
            if (!hasActiveLease) {
              checks.push({
                name: `active-no-lease:${action.id}`,
                category: "actions",
                status: "warn",
                message: `Action "${action.title}" is active but has no active lease`,
                fixable: false,
              });
            }
          }

          if (action.status === "blocked") {
            const deps = allEdges.filter(
              (e) => e.sourceActionId === action.id && e.type === "requires",
            );
            if (deps.length > 0) {
              const allDone = deps.every((d) => {
                const target = actionMap.get(d.targetActionId);
                return target && target.status === "done";
              });
              if (allDone) {
                checks.push({
                  name: `blocked-deps-done:${action.id}`,
                  category: "actions",
                  status: "fail",
                  message: `Action "${action.title}" is blocked but all dependencies are done`,
                  fixable: true,
                });
              }
            }
          }

          if (action.status === "pending") {
            const deps = allEdges.filter(
              (e) => e.sourceActionId === action.id && e.type === "requires",
            );
            if (deps.length > 0) {
              const hasUnsatisfied = deps.some((d) => {
                const target = actionMap.get(d.targetActionId);
                return !target || target.status !== "done";
              });
              if (hasUnsatisfied) {
                checks.push({
                  name: `pending-unsatisfied-deps:${action.id}`,
                  category: "actions",
                  status: "fail",
                  message: `Action "${action.title}" is pending but has unsatisfied dependencies`,
                  fixable: true,
                });
              }
            }
          }
        }

        if (
          !checks.some((c) => c.category === "actions" && c.status !== "pass")
        ) {
          checks.push({
            name: "actions-ok",
            category: "actions",
            status: "pass",
            message: `All ${actions.length} actions are consistent`,
            fixable: false,
          });
        }
      }

      if (categories.includes("leases")) {
        const leases = await kv.list<Lease>(KV.leases);
        const actions = await kv.list<Action>(KV.actions);
        const actionIds = new Set(actions.map((a) => a.id));
        let leaseIssues = 0;

        for (const lease of leases) {
          if (
            lease.status === "active" &&
            new Date(lease.expiresAt).getTime() <= now
          ) {
            checks.push({
              name: `expired-lease:${lease.id}`,
              category: "leases",
              status: "fail",
              message: `Lease ${lease.id} for action ${lease.actionId} expired at ${lease.expiresAt}`,
              fixable: true,
            });
            leaseIssues++;
          }

          if (!actionIds.has(lease.actionId)) {
            checks.push({
              name: `orphaned-lease:${lease.id}`,
              category: "leases",
              status: "fail",
              message: `Lease ${lease.id} references non-existent action ${lease.actionId}`,
              fixable: true,
            });
            leaseIssues++;
          }
        }

        if (leaseIssues === 0) {
          checks.push({
            name: "leases-ok",
            category: "leases",
            status: "pass",
            message: `All ${leases.length} leases are healthy`,
            fixable: false,
          });
        }
      }

      if (categories.includes("sentinels")) {
        const sentinels = await kv.list<Sentinel>(KV.sentinels);
        const actions = await kv.list<Action>(KV.actions);
        const actionIds = new Set(actions.map((a) => a.id));
        let sentinelIssues = 0;

        for (const sentinel of sentinels) {
          if (
            sentinel.status === "watching" &&
            sentinel.expiresAt &&
            new Date(sentinel.expiresAt).getTime() <= now
          ) {
            checks.push({
              name: `expired-sentinel:${sentinel.id}`,
              category: "sentinels",
              status: "fail",
              message: `Sentinel "${sentinel.name}" expired at ${sentinel.expiresAt}`,
              fixable: true,
            });
            sentinelIssues++;
          }

          for (const actionId of sentinel.linkedActionIds) {
            if (!actionIds.has(actionId)) {
              checks.push({
                name: `sentinel-missing-action:${sentinel.id}:${actionId}`,
                category: "sentinels",
                status: "warn",
                message: `Sentinel "${sentinel.name}" references non-existent action ${actionId}`,
                fixable: false,
              });
              sentinelIssues++;
            }
          }
        }

        if (sentinelIssues === 0) {
          checks.push({
            name: "sentinels-ok",
            category: "sentinels",
            status: "pass",
            message: `All ${sentinels.length} sentinels are healthy`,
            fixable: false,
          });
        }
      }

      if (categories.includes("sketches")) {
        const sketches = await kv.list<Sketch>(KV.sketches);
        let sketchIssues = 0;

        for (const sketch of sketches) {
          if (
            sketch.status === "active" &&
            new Date(sketch.expiresAt).getTime() <= now
          ) {
            checks.push({
              name: `expired-sketch:${sketch.id}`,
              category: "sketches",
              status: "fail",
              message: `Sketch "${sketch.title}" expired at ${sketch.expiresAt}`,
              fixable: true,
            });
            sketchIssues++;
          }
        }

        if (sketchIssues === 0) {
          checks.push({
            name: "sketches-ok",
            category: "sketches",
            status: "pass",
            message: `All ${sketches.length} sketches are healthy`,
            fixable: false,
          });
        }
      }

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

      if (categories.includes("crystals")) {
        const crystals = await kv.list<Crystal>(KV.crystals);
        let crystalIssues = 0;
        for (const c of crystals) {
          if (typeof c.narrative !== "string" || c.narrative.trim().length === 0) {
            checks.push({
              name: `crystal-empty-narrative:${c.id}`,
              category: "crystals",
              status: "warn",
              message: `Crystal ${c.id} has empty narrative`,
              fixable: false,
            });
            crystalIssues++;
          }
        }
        if (crystalIssues === 0) {
          checks.push({
            name: "crystals-ok",
            category: "crystals",
            status: "pass",
            message: `All ${crystals.length} crystals are consistent`,
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
        const callers = [
          { caller: "prompt-submit", name: "injection-gate", label: "Injection Gate", off: "prompt-submit Injection is BM25-only" },
          { caller: "search", name: "search-gate", label: "Search gate", off: "smart-search keeps every hit above its relevance floor" },
        ] as const;
        for (const { caller, name, label, off } of callers) {
          const gate = injectionGateState(caller);
          const counts = `${gate.calls} calls, ${gate.fallbacks} fallbacks`;
          const failure = gate.lastFailure
            ? `, last failure ${gate.lastFailure.reason} at ${gate.lastFailure.at} (${gate.lastFailure.sinceBootSeconds}s since boot)`
            : "";
          checks.push({
            name,
            category: "injections",
            status: gate.enabled && gate.failing ? "warn" : "pass",
            message: gate.enabled ? `${label} on (${gate.url}): ${counts}${failure}` : `${label} off: ${off}`,
            fixable: false,
          });
        }
      }

      if (categories.includes("injection-use")) {
        const records = (await kv.list<InjectionRecord>(KV.injections)).filter((r) => {
          const age = now - Date.parse(r.at);
          return age >= UNUSED_INJECTION_SETTLE_MS && age <= TWENTY_FOUR_HOURS_MS && r.injected.length > 0;
        });
        const sessionIds = [...new Set(records.map((r) => r.sessionId))];
        const [observationsBySession, insightFiles] = await Promise.all([
          Promise.all(
            sessionIds.map(
              async (id) => [id, await kv.list<CompressedObservation>(KV.observations(id))] as const,
            ),
          ).then((entries) => new Map(entries)),
          resolveInsightFiles(kv, records),
        ]);
        const bySource = new Map<string, { scored: number; unused: number }>();
        const total = { scored: 0, unused: 0 };
        const insights = { scored: 0, unused: 0 };
        for (const record of records) {
          const tally = bySource.get(record.source) ?? { scored: 0, unused: 0 };
          const observations = observationsBySession.get(record.sessionId) ?? [];
          for (const ref of record.injected) {
            const isInsight = ref.kind === "insight";
            const use = injectedItemUse(isInsight ? withFiles(ref, insightFiles.get(ref.id)) : ref, record, observations);
            if (use === "unscorable") continue;
            for (const t of isInsight ? [insights] : [tally, total]) {
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
            ? `No scorable injected items${insights.scored > 0 ? " other than Insights" : ""} between 1h and 24h ago.`
            : `${share(total)}% of ${total.scored} injected items unused between 1h and 24h ago (${breakdown}); ` +
              `warns above ${UNUSED_INJECTION_WARN_SHARE * 100}% once ${UNUSED_INJECTION_MIN_ITEMS} items are scored. ` +
              "This is a proxy: an item counts as used when a later Observation in the same Session touched one of its files or named it, " +
              "and items with no files are not scored.";
        const insightNote =
          insights.scored > 0 &&
          `Insights ${share(insights)}% of ${insights.scored} unused, scored apart by their source Crystals' files and never warned on.`;
        checks.push({
          name: tooUnused ? "unused-injections" : "injection-use-ok",
          category: "injection-use",
          status: tooUnused ? "warn" : "pass",
          message: insightNote ? `${injectedItemsNote} ${insightNote}` : injectedItemsNote,
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

      if (categories.includes("actions")) {
        const actions = await kv.list<Action>(KV.actions);
        const allEdges = await kv.list<ActionEdge>(KV.actionEdges);
        const actionMap = new Map(actions.map((a) => [a.id, a]));

        for (const action of actions) {
          if (action.status === "blocked") {
            const deps = allEdges.filter(
              (e) => e.sourceActionId === action.id && e.type === "requires",
            );
            if (deps.length > 0) {
              const allDone = deps.every((d) => {
                const target = actionMap.get(d.targetActionId);
                return target && target.status === "done";
              });
              if (allDone) {
                if (dryRun) {
                  details.push(
                    `[dry-run] Would unblock action "${action.title}" (${action.id})`,
                  );
                  fixed++;
                  continue;
                }
                const didFix = await withKeyedLock(
                  `mem:action:${action.id}`,
                  async () => {
                    const fresh = await kv.get<Action>(KV.actions, action.id);
                    if (!fresh || fresh.status !== "blocked") return false;
                    const freshEdges = await kv.list<ActionEdge>(KV.actionEdges);
                    const freshDeps = freshEdges.filter(
                      (e) =>
                        e.sourceActionId === fresh.id && e.type === "requires",
                    );
                    const freshActions = await kv.list<Action>(KV.actions);
                    const freshMap = new Map(
                      freshActions.map((a) => [a.id, a]),
                    );
                    const stillAllDone = freshDeps.every((d) => {
                      const target = freshMap.get(d.targetActionId);
                      return target && target.status === "done";
                    });
                    if (!stillAllDone) return false;
                    fresh.status = "pending";
                    fresh.updatedAt = new Date().toISOString();
                    await kv.set(KV.actions, fresh.id, fresh);
                    await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
                      reason: "blocked-deps-done",
                      previousStatus: "blocked",
                      newStatus: "pending",
                    });
                    return true;
                  },
                );
                if (didFix) {
                  details.push(
                    `Unblocked action "${action.title}" (${action.id})`,
                  );
                  fixed++;
                } else {
                  skipped++;
                }
              }
            }
          }

          if (action.status === "pending") {
            const deps = allEdges.filter(
              (e) => e.sourceActionId === action.id && e.type === "requires",
            );
            if (deps.length > 0) {
              const hasUnsatisfied = deps.some((d) => {
                const target = actionMap.get(d.targetActionId);
                return !target || target.status !== "done";
              });
              if (hasUnsatisfied) {
                if (dryRun) {
                  details.push(
                    `[dry-run] Would block action "${action.title}" (${action.id})`,
                  );
                  fixed++;
                  continue;
                }
                const didFix = await withKeyedLock(
                  `mem:action:${action.id}`,
                  async () => {
                    const fresh = await kv.get<Action>(KV.actions, action.id);
                    if (!fresh || fresh.status !== "pending") return false;
                    const freshEdges = await kv.list<ActionEdge>(KV.actionEdges);
                    const freshDeps = freshEdges.filter(
                      (e) =>
                        e.sourceActionId === fresh.id && e.type === "requires",
                    );
                    const freshActions = await kv.list<Action>(KV.actions);
                    const freshMap = new Map(
                      freshActions.map((a) => [a.id, a]),
                    );
                    const stillUnsatisfied = freshDeps.some((d) => {
                      const target = freshMap.get(d.targetActionId);
                      return !target || target.status !== "done";
                    });
                    if (!stillUnsatisfied) return false;
                    fresh.status = "blocked";
                    fresh.updatedAt = new Date().toISOString();
                    await kv.set(KV.actions, fresh.id, fresh);
                    await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
                      reason: "pending-unsatisfied-deps",
                      previousStatus: "pending",
                      newStatus: "blocked",
                    });
                    return true;
                  },
                );
                if (didFix) {
                  details.push(
                    `Blocked action "${action.title}" (${action.id})`,
                  );
                  fixed++;
                } else {
                  skipped++;
                }
              }
            }
          }
        }
      }

      if (categories.includes("leases")) {
        const leases = await kv.list<Lease>(KV.leases);
        const actions = await kv.list<Action>(KV.actions);
        const actionIds = new Set(actions.map((a) => a.id));

        for (const lease of leases) {
          if (
            lease.status === "active" &&
            new Date(lease.expiresAt).getTime() <= now
          ) {
            if (dryRun) {
              details.push(
                `[dry-run] Would expire lease ${lease.id} for action ${lease.actionId}`,
              );
              fixed++;
              continue;
            }
            const didFix = await withKeyedLock(
              `mem:action:${lease.actionId}`,
              async () => {
                const fresh = await kv.get<Lease>(KV.leases, lease.id);
                if (
                  !fresh ||
                  fresh.status !== "active" ||
                  new Date(fresh.expiresAt).getTime() > Date.now()
                ) {
                  return false;
                }
                fresh.status = "expired";
                await kv.set(KV.leases, fresh.id, fresh);
                await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
                  entityType: "lease",
                  reason: "expired-lease",
                  newStatus: "expired",
                });

                const action = await kv.get<Action>(KV.actions, fresh.actionId);
                if (
                  action &&
                  action.status === "active" &&
                  action.assignedTo === fresh.agentId
                ) {
                  action.status = "pending";
                  action.assignedTo = undefined;
                  action.updatedAt = new Date().toISOString();
                  await kv.set(KV.actions, action.id, action);
                  await recordAudit(kv, "heal", "mem::heal", [action.id], {
                    entityType: "action",
                    reason: "release-expired-lease",
                    newStatus: "pending",
                  });
                }
                return true;
              },
            );
            if (didFix) {
              details.push(
                `Expired lease ${lease.id} for action ${lease.actionId}`,
              );
              fixed++;
            } else {
              skipped++;
            }
            continue;
          }

          if (!actionIds.has(lease.actionId)) {
            if (dryRun) {
              details.push(
                `[dry-run] Would delete orphaned lease ${lease.id}`,
              );
              fixed++;
              continue;
            }
            await kv.delete(KV.leases, lease.id);
            await recordAudit(kv, "heal", "mem::heal", [lease.id], {
              entityType: "lease",
              reason: "orphaned-lease",
              action: "delete",
            });
            details.push(`Deleted orphaned lease ${lease.id}`);
            fixed++;
          }
        }
      }

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

      if (categories.includes("sentinels")) {
        const sentinels = await kv.list<Sentinel>(KV.sentinels);

        for (const sentinel of sentinels) {
          if (
            sentinel.status === "watching" &&
            sentinel.expiresAt &&
            new Date(sentinel.expiresAt).getTime() <= now
          ) {
            if (dryRun) {
              details.push(
                `[dry-run] Would expire sentinel "${sentinel.name}" (${sentinel.id})`,
              );
              fixed++;
              continue;
            }
            const didFix = await withKeyedLock(
              `mem:sentinel:${sentinel.id}`,
              async () => {
                const fresh = await kv.get<Sentinel>(
                  KV.sentinels,
                  sentinel.id,
                );
                if (!fresh || fresh.status !== "watching") return false;
                if (
                  !fresh.expiresAt ||
                  new Date(fresh.expiresAt).getTime() > Date.now()
                ) {
                  return false;
                }
                fresh.status = "expired";
                await kv.set(KV.sentinels, fresh.id, fresh);
                await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
                  entityType: "sentinel",
                  reason: "expired-sentinel",
                  newStatus: "expired",
                });
                return true;
              },
            );
            if (didFix) {
              details.push(
                `Expired sentinel "${sentinel.name}" (${sentinel.id})`,
              );
              fixed++;
            } else {
              skipped++;
            }
          }
        }
      }

      if (categories.includes("sketches")) {
        const sketches = await kv.list<Sketch>(KV.sketches);

        for (const sketch of sketches) {
          if (
            sketch.status === "active" &&
            new Date(sketch.expiresAt).getTime() <= now
          ) {
            if (dryRun) {
              details.push(
                `[dry-run] Would discard expired sketch "${sketch.title}" (${sketch.id})`,
              );
              fixed++;
              continue;
            }
            const didFix = await withKeyedLock(
              `mem:sketch:${sketch.id}`,
              async () => {
                const fresh = await kv.get<Sketch>(KV.sketches, sketch.id);
                if (
                  !fresh ||
                  fresh.status !== "active" ||
                  new Date(fresh.expiresAt).getTime() > Date.now()
                ) {
                  return false;
                }

                const allEdges = await kv.list<ActionEdge>(KV.actionEdges);
                const actionIdSet = new Set(fresh.actionIds);
                for (const edge of allEdges) {
                  if (
                    actionIdSet.has(edge.sourceActionId) ||
                    actionIdSet.has(edge.targetActionId)
                  ) {
                    await kv.delete(KV.actionEdges, edge.id);
                    await recordAudit(kv, "heal", "mem::heal", [edge.id], {
                      entityType: "actionEdge",
                      reason: "sketch-gc-discard",
                      action: "delete",
                    });
                  }
                }
                for (const actionId of fresh.actionIds) {
                  await kv.delete(KV.actions, actionId);
                  await recordAudit(kv, "heal", "mem::heal", [actionId], {
                    entityType: "action",
                    reason: "sketch-gc-discard",
                    action: "delete",
                  });
                }

                fresh.status = "discarded";
                fresh.discardedAt = new Date().toISOString();
                await kv.set(KV.sketches, fresh.id, fresh);
                await recordAudit(kv, "heal", "mem::heal", [fresh.id], {
                  entityType: "sketch",
                  reason: "expired-sketch",
                  newStatus: "discarded",
                });
                return true;
              },
            );
            if (didFix) {
              details.push(
                `Discarded expired sketch "${sketch.title}" (${sketch.id})`,
              );
              fixed++;
            } else {
              skipped++;
            }
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
