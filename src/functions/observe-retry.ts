import type { HookPayload } from "../types.js";
import { logger } from "../logger.js";

// Telemetry hooks fire and forget, so an Observation that hits a full disk is
// gone unless the daemon keeps it. On dev the disk stayed full for 12 minutes;
// the queue holds the Observations in memory until a write succeeds. They are
// still lost if the daemon restarts before the disk frees.
export const OBSERVE_RETRY_CAPACITY = 1000;
export const OBSERVE_RETRY_INTERVAL_MS = 30_000;

export function isDiskFull(err: unknown): boolean {
  return err instanceof Error && err.message.includes("database or disk is full");
}

export class ObserveRetryQueue {
  private readonly pending: HookPayload[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  constructor(private readonly observe: (payload: HookPayload) => Promise<unknown>) {}

  enqueue(payload: HookPayload): boolean {
    if (this.pending.length >= OBSERVE_RETRY_CAPACITY) return false;
    this.pending.push(payload);
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
          await this.observe(this.pending[0]);
        } catch (err) {
          if (isDiskFull(err)) return;
          logger.error("Dropped queued Observation after a non-disk-full error", {
            sessionId: this.pending[0].sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.pending.shift();
      }
      clearInterval(this.timer);
      this.timer = undefined;
    } finally {
      this.draining = false;
    }
  }
}
