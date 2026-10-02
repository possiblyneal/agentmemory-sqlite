import { TriggerAction, type ISdk } from "../engine/types.js";
import type { CompressedObservation, HookPayload, Session } from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import {
  getAgentId,
  getConsolidationCooldownMs,
  isConsolidationEnabled,
  isGraphExtractionEnabled,
} from "../config.js";
import { graphLegDisabled } from "../state/graph-indexes.js";
import { recordProjectActivity } from "../state/project-time.js";
import { logger } from "../logger.js";

// Global marker recording when corpus consolidation last ran, used to debounce
// the per-turn session-stop fan-out.
const CONSOLIDATION_MARKER_KEY = "consolidation:lastRun";

// A raw Observation older than this is taken to be a compression that never
// finished, so it stops holding back graph extraction.
const PENDING_COMPRESSION_HOLD_MS = 60 * 60 * 1000;

async function consolidationDueUnserialized(kv: StateKV): Promise<boolean> {
  const cooldownMs = getConsolidationCooldownMs();
  if (cooldownMs <= 0) return true; // debounce disabled
  const now = Date.now();
  const marker = await kv
    .get<{ at?: number }>(KV.config, CONSOLIDATION_MARKER_KEY)
    .catch(() => null);
  const lastAt = typeof marker?.at === "number" ? marker.at : 0;
  if (now - lastAt < cooldownMs) return false;
  await kv.set(KV.config, CONSOLIDATION_MARKER_KEY, { at: now }).catch(() => {});
  return true;
}

// Concurrent session-stop events would otherwise interleave the marker
// read-check-write above and both pass the cooldown. Serialize the whole
// check through an in-process chain so exactly one concurrent caller wins.
let consolidationCheckChain: Promise<unknown> = Promise.resolve();

function consolidationDue(kv: StateKV): Promise<boolean> {
  const result = consolidationCheckChain.then(() =>
    consolidationDueUnserialized(kv),
  );
  consolidationCheckChain = result.catch(() => false);
  return result;
}

export function registerEventTriggers(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "event::session::started",
    async (data: {
      sessionId: string;
      project: string;
      cwd: string;
      agentId?: string;
    }) => {
      const requestAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const session: Session = {
        id: data.sessionId,
        project: data.project,
        cwd: data.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(agentId ? { agentId } : {}),
      };
      await kv.set(KV.sessions, data.sessionId, session);
      await recordProjectActivity(kv, data.project, session.startedAt);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string; agentId?: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: {
          sessionId: data.sessionId,
          project: data.project,
          ...(agentId ? { agentId } : {}),
        },
      });
      return { session, context: contextResult.context };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  // recovery marks a stop driven by Eviction's stale-Session recovery, which
  // holds at most one LLM slot: chunks run one at a time, reflect and graph
  // extraction are awaited rather than fired, and consolidation is left to
  // Eviction's single pass.
  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string; recovery?: boolean }) => {
    const summary = await sdk.trigger({
      function_id: "mem::summarize",
      payload: { sessionId: data.sessionId, ...(data.recovery && { sequentialChunks: true }) },
    });
    const fanOut = (function_id: string, payload: unknown) =>
      sdk
        .trigger({
          function_id,
          payload,
          ...(!data.recovery && { action: TriggerAction.Void() }),
        })
        .catch((err) =>
          logger.warn(function_id + " trigger failed", {
            sessionId: data.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    if (isReflectEnabled()) {
      await fanOut("mem::slot-reflect", { sessionId: data.sessionId });
    }
    // Fork posture (graph-off). Stock 0.9.29 fires this unconditionally and
    // lets mem::graph-extract gate only its LLM pass, so a keyless install
    // grows the graph from every session stop. Here the whole fan-out needs
    // the extraction flag AND the graph leg not killed (AGENTMEMORY_GRAPH_LEG).
    //
    // A Session ends at every idle gap, so extraction takes only the
    // Observations newer than the Session's watermark. It stops short of the
    // oldest one still awaiting compression, which keeps its timestamp once
    // compressed and would otherwise fall behind the watermark, unless it has
    // been waiting longer than PENDING_COMPRESSION_HOLD_MS.
    // mem::graph-extract moves the watermark past the batches that succeed, so
    // a failed batch is retried at the next stop.
    if (isGraphExtractionEnabled() && !graphLegDisabled()) {
      try {
        const [session, observations] = await Promise.all([
          kv.get<Session>(KV.sessions, data.sessionId),
          kv.list<CompressedObservation>(KV.observations(data.sessionId)),
        ]);
        const extractedThrough = session?.graphExtractedThrough ?? "";
        const unseen = observations.filter((o) => o.timestamp > extractedThrough);
        const holdSince = new Date(Date.now() - PENDING_COMPRESSION_HOLD_MS).toISOString();
        const oldestPending = unseen
          .filter((o) => !o.title && o.timestamp > holdSince)
          .reduce<string | undefined>(
            (min, o) => (min === undefined || o.timestamp < min ? o.timestamp : min),
            undefined,
          );
        const fresh = unseen.filter(
          (o) => o.title && (oldestPending === undefined || o.timestamp < oldestPending),
        );
        if (session && fresh.length > 0) {
          await fanOut("mem::graph-extract", {
            observations: fresh,
            sessionId: data.sessionId,
          });
        }
      } catch (err) {
        logger.warn("graph-extract trigger failed", {
          sessionId: data.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Crystals + lessons consolidation. The stop lifecycle is the single
    // source of truth: event::session::stopped fires for ALL agents (the
    // client-side session-end hook no longer drives consolidation directly).
    // Gated so keyless/zero-LLM users don't fire no-op LLM calls.
    //
    // recovery suppresses the fan-out when this handler is driven
    // by eviction's stale-session recovery: evict calls session::stopped
    // once per recovered session, then runs ONE final consolidation pass.
    // Without this guard, N recovered sessions launch N concurrent forced
    // full-corpus consolidations plus N crystallizations.
    //
    // Debounce: /session/end is posted by the per-turn Stop hook, so this
    // handler fires on every agent turn. consolidate-pipeline + auto-crystallize
    // are full-corpus LLM work with no internal "nothing changed" guard, so
    // firing them every turn is a cost/latency storm for connected agents.
    // Bound the global corpus consolidation to once per cooldown window.
    if (isConsolidationEnabled() && !data.recovery) {
      if (await consolidationDue(kv)) {
        fanOut("mem::consolidate-pipeline", { tier: "all", force: true });
        fanOut("mem::auto-crystallize", { olderThanDays: 0 });
      }
    }
    return summary;
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) => {
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: new Date().toISOString() },
        { type: "set", path: "status", value: "completed" },
      ]);
      return { success: true };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  // React to observation count changes and emit a lightweight live event for dashboards/viewer.
  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      if (payload.event_type === "delete") return { skipped: true };
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { skipped: true };

      await sdk.trigger({
        function_id: "stream::send",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `session-activity-${payload.key}-${Date.now()}`,
          type: "session.activity",
          data: {
            sessionId: payload.key,
            observationCount: newCount,
            delta: newCount - oldCount,
            updatedAt: new Date().toISOString(),
          },
        },
        action: TriggerAction.Void(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });
}
