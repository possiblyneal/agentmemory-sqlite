import type { HealthSnapshot } from "../types.js";
import { getHealthTuning } from "../config.js";
import type { HealthTuning } from "../config.js";

type ThresholdConfig = Omit<HealthTuning, "assertSamples" | "clearSamples">;

export type HealthStatus = "healthy" | "degraded" | "critical";

// The published verdict is a restart signal to an external supervisor, so it
// must not follow a single reading: one slow GC inside a sampling window is
// not a sick daemon. `pending` is the verdict the recent samples are arguing
// for and `run` is how many in a row have argued for it; the published verdict
// only moves once that run reaches the configured count. The monitor holds
// this in its own closure and never persists it — a restart legitimately
// resets the judgement (#1170).
export type HealthHysteresis = {
  published: HealthStatus;
  pending: HealthStatus;
  run: number;
};

const SEVERITY: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  critical: 2,
};

export function evaluateHealth(
  snapshot: HealthSnapshot,
  config: Partial<ThresholdConfig> = {},
  prior?: HealthHysteresis,
): {
  status: HealthStatus;
  alerts: string[];
  notes: string[];
  hysteresis: HealthHysteresis;
} {
  // Environment first, explicit config last: a caller that names a threshold
  // means it (#1172).
  const tuning = getHealthTuning();
  const cfg = { ...tuning, ...config };
  const alerts: string[] = [];
  const notes: string[] = [];
  let critical = false;
  let degraded = false;

  if (
    snapshot.connectionState === "disconnected" ||
    snapshot.connectionState === "failed"
  ) {
    alerts.push(`connection_${snapshot.connectionState}`);
    critical = true;
  } else if (snapshot.connectionState === "reconnecting") {
    alerts.push("connection_reconnecting");
    degraded = true;
  }

  if (snapshot.eventLoopLagMs > cfg.eventLoopLagCriticalMs) {
    alerts.push(
      `event_loop_lag_critical_${Math.round(snapshot.eventLoopLagMs)}ms`,
    );
    critical = true;
  } else if (snapshot.eventLoopLagMs > cfg.eventLoopLagWarnMs) {
    alerts.push(`event_loop_lag_warn_${Math.round(snapshot.eventLoopLagMs)}ms`);
    degraded = true;
  }

  if (snapshot.cpu.percent > cfg.cpuCriticalPercent) {
    alerts.push(`cpu_critical_${Math.round(snapshot.cpu.percent)}%`);
    critical = true;
  } else if (snapshot.cpu.percent > cfg.cpuWarnPercent) {
    alerts.push(`cpu_warn_${Math.round(snapshot.cpu.percent)}%`);
    degraded = true;
  }

  // Measure heapUsed against V8's --max-old-space-size ceiling, NOT against
  // heapTotal. heapTotal is only what V8 has reserved so far and it grows
  // lazily, so heapUsed/heapTotal sits near 100% by design in any steady-state
  // process - it alerted "degraded/critical" forever on a daemon with gigabytes
  // of headroom. heap_size_limit is the boundary the process actually OOMs at.
  const heapLimit = snapshot.memory.heapLimit ?? 0;
  const memPercent =
    heapLimit > 0 ? (snapshot.memory.heapUsed / heapLimit) * 100 : 0;
  const rss = snapshot.memory.rss ?? 0;
  const rssAboveFloor = rss >= cfg.memoryRssFloorBytes;
  const memMb = Math.round(rss / (1024 * 1024));
  if (memPercent > cfg.memoryCriticalPercent && rssAboveFloor) {
    alerts.push(`memory_critical_${Math.round(memPercent)}%_rss${memMb}mb`);
    critical = true;
  } else if (memPercent > cfg.memoryWarnPercent && rssAboveFloor) {
    alerts.push(`memory_warn_${Math.round(memPercent)}%_rss${memMb}mb`);
    degraded = true;
  } else if (memPercent > cfg.memoryWarnPercent) {
    notes.push(`memory_heap_tight_${Math.round(memPercent)}%_rss${memMb}mb`);
  }

  const sampled: HealthStatus = critical
    ? "critical"
    : degraded
      ? "degraded"
      : "healthy";

  // No prior state is the first sample after startup: publish it directly so
  // the daemon is judged promptly rather than staying unjudged while a run
  // accumulates.
  if (!prior) {
    return {
      status: sampled,
      alerts,
      notes,
      hysteresis: { published: sampled, pending: sampled, run: 0 },
    };
  }

  if (sampled === prior.published) {
    return {
      status: prior.published,
      alerts,
      notes,
      hysteresis: { published: prior.published, pending: sampled, run: 0 },
    };
  }

  // Asserting a verdict and clearing one are counted separately: an operator
  // may want to hear about trouble sooner than they hear about recovery.
  // Clearing is any move toward healthy, not just arrival at it - stepping
  // critical -> degraded de-escalates the restart signal and has to earn the
  // same patience as clearing it outright.
  const needed = SEVERITY[sampled] < SEVERITY[prior.published]
    ? tuning.clearSamples
    : tuning.assertSamples;
  const run = sampled === prior.pending ? prior.run + 1 : 1;
  const published = run >= needed ? sampled : prior.published;
  return {
    status: published,
    alerts,
    notes,
    hysteresis: { published, pending: sampled, run: published === sampled ? 0 : run },
  };
}
