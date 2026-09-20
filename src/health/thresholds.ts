import type { HealthSnapshot } from "../types.js";
import { getHealthTuning } from "../config.js";
import type { HealthTuning } from "../config.js";

type ThresholdConfig = Omit<HealthTuning, "assertSamples" | "clearSamples">;

export type HealthStatus = "healthy" | "degraded" | "critical";

// The published verdict is a restart signal to an external supervisor, so it
// must not follow a single reading: one slow GC inside a sampling window is
// not a sick daemon. `run` is how many samples in a row have disagreed with
// the published verdict; the published verdict only moves once that run
// reaches the configured count, and then it moves to the newest sample. The
// monitor holds this in its own closure and never persists it — a restart
// legitimately resets the judgement (#1170).
//
// A run toward trouble and a run toward health are different arguments and
// are counted separately, so `clearing` records which one the run is making.
export type HealthHysteresis = {
  published: HealthStatus;
  run: number;
  clearing: boolean;
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
      hysteresis: { published: sampled, run: 0, clearing: false },
    };
  }

  if (sampled === prior.published) {
    return {
      status: prior.published,
      alerts,
      notes,
      hysteresis: { published: prior.published, run: 0, clearing: false },
    };
  }

  // Asserting a verdict and clearing one are counted separately: an operator
  // may want to hear about trouble sooner than they hear about recovery.
  // Clearing is any move toward healthy, not just arrival at it - stepping
  // critical -> degraded de-escalates the restart signal and has to earn the
  // same patience as clearing it outright.
  const clearing = SEVERITY[sampled] < SEVERITY[prior.published];
  const needed = clearing ? tuning.clearSamples : tuning.assertSamples;
  // The run counts samples that disagree with the published verdict, not
  // identical consecutive samples. A daemon oscillating degraded <-> critical
  // disagrees on every sample; counting identity would reset the run on each
  // flip and hold `healthy` forever while nothing is healthy. One agreeing
  // sample still breaks the run, and the verdict moves to the newest sample.
  //
  // A sample that turns the run around starts a new one: otherwise a run
  // accumulated toward trouble would be spent on the shorter count a single
  // recovering sample asks for, publishing `healthy` off one healthy reading.
  const run = prior.clearing === clearing ? prior.run + 1 : 1;
  const published = run >= needed ? sampled : prior.published;
  return {
    status: published,
    alerts,
    notes,
    hysteresis: {
      published,
      run: published === sampled ? 0 : run,
      clearing: published === sampled ? false : clearing,
    },
  };
}
