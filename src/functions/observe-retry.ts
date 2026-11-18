import type { HookPayload } from "../types.js";
import { logger } from "../logger.js";

// Telemetry hooks fire and forget, so an Observation whose row write fails is
// gone unless the daemon keeps it. The daemon keeps it when the failure clears on
// its own: a full disk frees, and another connection's write lock is released.
// The queue lives in memory: a restart before the write succeeds still loses it.
export const OBSERVE_RETRY_CAPACITY_BYTES = 64 * 1024 * 1024;
export const OBSERVE_RETRY_INTERVAL_MS = 30_000;

// The Engine rethrows handler errors as InprocInvocationError, which keeps the
// message but not node:sqlite's errcode, so every check matches on message text.
const SQLITE_FULL_MESSAGE = "database or disk is full";
const SQLITE_LOCKED_MESSAGE = "database is locked";
const RETRYABLE_CAUSES = [SQLITE_FULL_MESSAGE, SQLITE_LOCKED_MESSAGE];
const UNSTORED_PREFIX = "Observation not stored: ";

// The cause, when a failed write may succeed if replayed later.
export function retryableWriteCause(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  return RETRYABLE_CAUSES.find((cause) => err.message.includes(cause));
}

// Only a failed row write is safe to replay. A failure after the row is stored
// would replay as a duplicate, or as a no-op once dedup has recorded it.
export function unstored(cause: string): Error {
  return new Error(UNSTORED_PREFIX + cause);
}

export function unstoredOnFullDisk(): Error {
  return unstored(SQLITE_FULL_MESSAGE);
}

export function isUnstored(err: unknown): boolean {
  return (
    err instanceof Error &&
    RETRYABLE_CAUSES.some((cause) => err.message.includes(UNSTORED_PREFIX + cause))
  );
}

export class ObserveRetryQueue {
  private readonly pending: Array<{ payload: HookPayload; bytes: number }> = [];
  private pendingBytes = 0;
  private queuedSinceEmpty = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  constructor(private readonly observe: (payload: HookPayload) => Promise<unknown>) {}

  // Once anything is queued, later Observations queue behind it so the Session
  // stores them in arrival order; each one also prompts a drain. Past the cap
  // an Observation is dropped rather than written ahead of the queue.
  async submit(payload: HookPayload): Promise<{ queued: true } | { queued: false; result: unknown }> {
    if (this.pending.length > 0) {
      if (!this.enqueue(payload)) {
        logger.error("Dropped Observation: the retry queue is at its cap", {
          sessionId: payload.sessionId,
        });
        throw new Error(UNSTORED_PREFIX + "retry queue is at its cap");
      }
      void this.drain();
      return { queued: true };
    }
    try {
      return { queued: false, result: await this.observe(payload) };
    } catch (err) {
      if (isUnstored(err) && this.enqueue(payload, (err as Error).message)) return { queued: true };
      throw err;
    }
  }

  // `cause` names the failed write that starts the queue; it is logged only then.
  private enqueue(payload: HookPayload, cause?: string): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (this.pendingBytes + bytes > OBSERVE_RETRY_CAPACITY_BYTES) return false;
    if (this.pending.length === 0) {
      logger.warn("Observation write failed: queuing Observations in memory until a write succeeds", {
        sessionId: payload.sessionId,
        cause,
      });
    }
    this.pending.push({ payload, bytes });
    this.pendingBytes += bytes;
    this.queuedSinceEmpty++;
    if (!this.timer) {
      this.timer = setInterval(() => void this.drain(), OBSERVE_RETRY_INTERVAL_MS);
      this.timer.unref?.();
    }
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        try {
          await this.observe(this.pending[0].payload);
        } catch (err) {
          if (isUnstored(err)) return;
          logger.error("Dropped queued Observation after an error that does not clear on its own", {
            sessionId: this.pending[0].payload.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.pendingBytes -= this.pending.shift()!.bytes;
      }
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info("Observation queue drained after a failed write", {
        queued: this.queuedSinceEmpty,
      });
      this.queuedSinceEmpty = 0;
    } finally {
      this.draining = false;
    }
  }
}
