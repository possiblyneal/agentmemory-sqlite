import type { HookPayload } from "../types.js";
import { logger } from "../logger.js";

// Telemetry hooks fire and forget, so an Observation that hits a full disk is
// gone unless the daemon keeps it. The queue lives in memory: a restart before
// the disk frees still loses it.
export const OBSERVE_RETRY_CAPACITY_BYTES = 64 * 1024 * 1024;
export const OBSERVE_RETRY_INTERVAL_MS = 30_000;

// The Engine rethrows handler errors as InprocInvocationError, which keeps the
// message but not node:sqlite's errcode, so both checks match on message text.
const SQLITE_FULL_MESSAGE = "database or disk is full";
const UNSTORED_FULL_MESSAGE = "Observation not stored: " + SQLITE_FULL_MESSAGE;

export function isSqliteFull(err: unknown): boolean {
  return err instanceof Error && err.message.includes(SQLITE_FULL_MESSAGE);
}

// Only a failed row write is safe to replay. A failure after the row is stored
// would replay as a duplicate, or as a no-op once dedup has recorded it.
export function unstoredOnFullDisk(): Error {
  return new Error(UNSTORED_FULL_MESSAGE);
}

export function isUnstoredOnFullDisk(err: unknown): boolean {
  return err instanceof Error && err.message.includes(UNSTORED_FULL_MESSAGE);
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
        logger.error("Dropped Observation: the disk-full queue is at its cap", {
          sessionId: payload.sessionId,
        });
        throw new Error("Observation not stored: disk-full queue is at its cap");
      }
      void this.drain();
      return { queued: true };
    }
    try {
      return { queued: false, result: await this.observe(payload) };
    } catch (err) {
      if (isUnstoredOnFullDisk(err) && this.enqueue(payload)) return { queued: true };
      throw err;
    }
  }

  private enqueue(payload: HookPayload): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (this.pendingBytes + bytes > OBSERVE_RETRY_CAPACITY_BYTES) return false;
    if (this.pending.length === 0) {
      logger.warn("Disk full: queuing Observations in memory until a write succeeds", {
        sessionId: payload.sessionId,
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
          if (isUnstoredOnFullDisk(err)) return;
          logger.error("Dropped queued Observation after an error other than a full disk", {
            sessionId: this.pending[0].payload.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.pendingBytes -= this.pending.shift()!.bytes;
      }
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info("Observation queue drained after a full disk", {
        queued: this.queuedSinceEmpty,
      });
      this.queuedSinceEmpty = 0;
    } finally {
      this.draining = false;
    }
  }
}
