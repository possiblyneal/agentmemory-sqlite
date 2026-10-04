import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Session } from "../types.js";
import { logger } from "../logger.js";
import { getIdleSessionMs } from "../config.js";

function isIdle(session: Session | null, cutoff: number): session is Session {
  if (!session || session.status !== "active") return false;
  const at = new Date(session.updatedAt ?? session.startedAt).getTime();
  return Number.isFinite(at) && at < cutoff;
}

// Closes active Sessions that have recorded no Observation for the idle window,
// through the same api::session::end path a client's SessionEnd takes, so
// summarize and graph extraction run as usual. Completed Sessions are skipped,
// which makes a repeat sweep a no-op. idleClosed lets work that resumes in the
// same terminal reopen the Session, so the next end re-summarizes it.
export function registerIdleSessionSweepFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::idle-session-sweep",
    async (): Promise<{ success: true; closed: number }> => {
      const cutoff = Date.now() - getIdleSessionMs();
      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      let closed = 0;
      for (const candidate of sessions) {
        if (!isIdle(candidate, cutoff)) continue;
        try {
          // Re-read so an Observation recorded since the listing keeps the Session open.
          const fresh = await kv.get<Session>(KV.sessions, candidate.id);
          if (!isIdle(fresh, cutoff)) continue;
          const ended = await sdk.trigger<unknown, { status_code: number }>({
            function_id: "api::session::end",
            payload: { body: { sessionId: candidate.id } },
          });
          if (ended?.status_code !== 200) continue;
          await kv.update(KV.sessions, candidate.id, [
            { type: "set", path: "idleClosed", value: true },
          ]);
          closed++;
        } catch (err) {
          logger.warn("Idle session close failed", {
            sessionId: candidate.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (closed > 0) logger.info("Idle session sweep complete", { closed });
      return { success: true, closed };
    },
  );
}
