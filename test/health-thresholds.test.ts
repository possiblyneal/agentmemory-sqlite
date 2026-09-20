import { afterEach, describe, expect, it } from "vitest";
import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

const MB = 1024 * 1024;

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory: { heapUsed: 0, heapTotal: 1, heapLimit: 4096 * MB, rss: 0, external: 0 },
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 1,
    kvConnectivity: { status: "ok", latencyMs: 1 },
    status: "healthy",
    alerts: [],
    ...over,
  };
}

describe("evaluateHealth memory severity", () => {
  it("stays healthy when heap fills a tiny steady-state process (issue #158)", () => {
    const s = snap({
      memory: {
        heapUsed: 45 * MB,
        heapTotal: 46 * MB,
        heapLimit: 4096 * MB,
        rss: 120 * MB,
        external: 0,
      },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.find((a) => a.startsWith("memory_"))).toBeUndefined();
    expect(notes.find((n) => n.startsWith("memory_heap_tight_"))).toBeUndefined();
  });

  it("stays healthy on the prod false-positive: heapUsed/heapTotal 93% with gigabytes of limit headroom", () => {
    // The 2026-08-19 readout: heapUsed 649MB, heapTotal 695MB, rss 1073MB on a
    // 16GB VM. Against heapTotal that is 93% and alerted forever; against the
    // real 4GB ceiling it is ~16%.
    const s = snap({
      memory: {
        heapUsed: 649 * MB,
        heapTotal: 695 * MB,
        heapLimit: 4096 * MB,
        rss: 1073 * MB,
        external: 0,
      },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.find((a) => a.startsWith("memory_"))).toBeUndefined();
    expect(notes.find((n) => n.startsWith("memory_heap_tight_"))).toBeUndefined();
  });

  it("goes critical when heapUsed nears the limit AND RSS is above the floor", () => {
    const s = snap({
      memory: {
        heapUsed: 970 * MB,
        heapTotal: 1000 * MB,
        heapLimit: 1000 * MB,
        rss: 1100 * MB,
        external: 0,
      },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("critical");
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(true);
  });

  it("records heap_tight in the warn band when RSS is below the floor", () => {
    const s = snap({
      memory: {
        heapUsed: 85 * MB,
        heapTotal: 100 * MB,
        heapLimit: 100 * MB,
        rss: 50 * MB,
        external: 0,
      },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(notes.some((n) => n.startsWith("memory_heap_tight_"))).toBe(true);
    expect(alerts.some((a) => a.startsWith("memory_"))).toBe(false);
  });

  it("goes degraded when heapUsed is above warn AND RSS is above the floor", () => {
    const s = snap({
      memory: {
        heapUsed: 850 * MB,
        heapTotal: 1000 * MB,
        heapLimit: 1000 * MB,
        rss: 900 * MB,
        external: 0,
      },
    });
    const { status, alerts } = evaluateHealth(s, { memoryRssFloorBytes: 800 * MB });
    expect(status).toBe("degraded");
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(true);
  });

  it("respects caller-supplied memoryRssFloorBytes", () => {
    const s = snap({
      memory: {
        heapUsed: 98,
        heapTotal: 100,
        heapLimit: 100,
        rss: 50 * MB,
        external: 0,
      },
    });
    const loose = evaluateHealth(s, { memoryRssFloorBytes: 10 * MB });
    expect(loose.status).toBe("critical");
    const strict = evaluateHealth(s, { memoryRssFloorBytes: 1024 * MB });
    expect(strict.status).toBe("healthy");
  });

  it("treats a missing heapLimit as no memory signal (snapshot from an old build)", () => {
    const s = snap();
    // a stored snapshot that predates the heapLimit field
    s.memory.heapLimit = undefined;
    s.memory.heapUsed = 970 * MB;
    s.memory.heapTotal = 1000 * MB;
    s.memory.rss = 1100 * MB;
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.some((a) => a.startsWith("memory_"))).toBe(false);
  });
});

// #1170: the published Health Verdict is a restart signal to an external
// supervisor. One slow GC inside a 30s sampling window used to be enough to
// publish `critical`, so a Verdict now changes only after three consecutive
// samples agree on the new one, in both directions.
describe("evaluateHealth verdict hysteresis", () => {
  const critical = snap({ connectionState: "failed" });
  const degraded = snap({ connectionState: "reconnecting" });
  const healthy = snap();

  // Feed a sequence through, threading hysteresis state the way the monitor
  // does, and return the Verdict published after each sample.
  function publishWith(
    config: Parameters<typeof evaluateHealth>[1],
    samples: HealthSnapshot[],
  ): string[] {
    let state = undefined as ReturnType<typeof evaluateHealth>["hysteresis"] | undefined;
    return samples.map((s) => {
      const r = evaluateHealth(s, config, state);
      state = r.hysteresis;
      return r.status;
    });
  }

  function publish(samples: HealthSnapshot[]): string[] {
    return publishWith({}, samples);
  }

  it("publishes a verdict on the first sample rather than staying unjudged", () => {
    expect(publish([critical])).toEqual(["critical"]);
  });

  it("ignores a single disagreeing sample", () => {
    expect(publish([healthy, critical])).toEqual(["healthy", "healthy"]);
  });

  it("ignores two consecutive disagreeing samples", () => {
    expect(publish([healthy, critical, critical])).toEqual([
      "healthy",
      "healthy",
      "healthy",
    ]);
  });

  it("changes the verdict on the third consecutive disagreeing sample", () => {
    expect(publish([healthy, critical, critical, critical])).toEqual([
      "healthy",
      "healthy",
      "healthy",
      "critical",
    ]);
  });

  it("starts the run over when one agreeing sample breaks it", () => {
    expect(
      publish([healthy, critical, critical, healthy, critical, critical]),
    ).toEqual(["healthy", "healthy", "healthy", "healthy", "healthy", "healthy"]);
  });

  it("never changes the verdict under an alternating sequence", () => {
    const alternating = [healthy, critical, healthy, critical, healthy, critical];
    expect(new Set(publish(alternating))).toEqual(new Set(["healthy"]));
  });

  it("counts samples that disagree with the verdict, however they disagree", () => {
    // Three samples in a row say "not healthy", so the verdict moves even
    // though they do not all name the same replacement. The daemon that
    // oscillates is the one a supervisor most needs to hear about.
    expect(publish([healthy, critical, degraded, critical])).toEqual([
      "healthy",
      "healthy",
      "healthy",
      "critical",
    ]);
  });

  it("judges a daemon oscillating between two unhealthy verdicts", () => {
    // Counting identical consecutive samples would reset the run on every
    // flip and hold `healthy` forever while nothing is healthy. Once a
    // verdict is published the next change starts its own run, so the last
    // sample here does not move it again.
    expect(publish([healthy, degraded, critical, degraded, critical])).toEqual([
      "healthy",
      "healthy",
      "healthy",
      "degraded",
      "degraded",
    ]);
  });

  it("publishes the newest sample, not the one that started the run", () => {
    expect(publish([healthy, degraded, degraded, critical])).toEqual([
      "healthy",
      "healthy",
      "healthy",
      "critical",
    ]);
  });

  it("clears a critical verdict only after three consecutive healthy samples", () => {
    expect(
      publish([critical, healthy, healthy, healthy, healthy]),
    ).toEqual(["critical", "critical", "critical", "healthy", "healthy"]);
  });

  it("subjects a jump from healthy straight to critical to the same count as a step through degraded", () => {
    const direct = publish([healthy, critical, critical, critical]);
    const stepped = publish([healthy, degraded, degraded, degraded]);
    expect(direct.indexOf("critical")).toBe(stepped.indexOf("degraded"));
  });

  it("reports the verdict of the sample just taken beside the published one", () => {
    // A reader shown alerts next to `healthy` has to be able to tell a
    // lagging verdict from a bug, so the sample's own verdict is reported.
    const first = evaluateHealth(healthy);
    const second = evaluateHealth(critical, {}, first.hysteresis);
    expect(second.status).toBe("healthy");
    expect(second.sampled).toBe("critical");
    expect(first.sampled).toBe("healthy");
  });

  it("honours a sample count named in explicit config", () => {
    // Thresholds passed explicitly are honoured, so the counts are too -
    // silently ignoring them is how a caller gets hysteresis it did not ask
    // for.
    expect(
      publishWith({ assertSamples: 1 }, [healthy, critical]),
    ).toEqual(["healthy", "critical"]);
  });

  it("reports the alerts of the sample just taken, not of the published verdict", () => {
    const first = evaluateHealth(healthy);
    const second = evaluateHealth(critical, {}, first.hysteresis);
    expect(second.status).toBe("healthy");
    expect(second.alerts).toContain("connection_failed");
  });

  it("classifies a lone sample exactly as before when no prior state is given", () => {
    expect(evaluateHealth(critical).status).toBe("critical");
    expect(evaluateHealth(degraded).status).toBe("degraded");
    expect(evaluateHealth(healthy).status).toBe("healthy");
  });
});

// #1172: the Operator tunes the health judgement from the environment so it
// travels across machines with different memory ceilings and load profiles.
// Defaults reproduce the previous behaviour exactly.
describe("evaluateHealth environment overrides", () => {
  const PREFIXED = [
    "AGENTMEMORY_HEALTH_EVENT_LOOP_LAG_WARN_MS",
    "AGENTMEMORY_HEALTH_EVENT_LOOP_LAG_CRITICAL_MS",
    "AGENTMEMORY_HEALTH_CPU_WARN_PERCENT",
    "AGENTMEMORY_HEALTH_CPU_CRITICAL_PERCENT",
    "AGENTMEMORY_HEALTH_MEMORY_WARN_PERCENT",
    "AGENTMEMORY_HEALTH_MEMORY_CRITICAL_PERCENT",
    "AGENTMEMORY_HEALTH_MEMORY_RSS_FLOOR_BYTES",
    "AGENTMEMORY_HEALTH_ASSERT_SAMPLES",
    "AGENTMEMORY_HEALTH_CLEAR_SAMPLES",
  ];

  afterEach(() => {
    for (const key of PREFIXED) delete process.env[key];
  });

  it("classifies a sample by the overridden event loop thresholds", () => {
    process.env["AGENTMEMORY_HEALTH_EVENT_LOOP_LAG_WARN_MS"] = "10";
    process.env["AGENTMEMORY_HEALTH_EVENT_LOOP_LAG_CRITICAL_MS"] = "20";
    expect(evaluateHealth(snap({ eventLoopLagMs: 15 })).status).toBe("degraded");
    expect(evaluateHealth(snap({ eventLoopLagMs: 25 })).status).toBe("critical");
  });

  it("classifies a sample by the overridden cpu thresholds", () => {
    process.env["AGENTMEMORY_HEALTH_CPU_WARN_PERCENT"] = "10";
    process.env["AGENTMEMORY_HEALTH_CPU_CRITICAL_PERCENT"] = "20";
    expect(
      evaluateHealth(snap({ cpu: { userMicros: 0, systemMicros: 0, percent: 15 } }))
        .status,
    ).toBe("degraded");
    expect(
      evaluateHealth(snap({ cpu: { userMicros: 0, systemMicros: 0, percent: 25 } }))
        .status,
    ).toBe("critical");
  });

  it("classifies a sample by the overridden memory thresholds and rss floor", () => {
    process.env["AGENTMEMORY_HEALTH_MEMORY_WARN_PERCENT"] = "10";
    process.env["AGENTMEMORY_HEALTH_MEMORY_CRITICAL_PERCENT"] = "20";
    process.env["AGENTMEMORY_HEALTH_MEMORY_RSS_FLOOR_BYTES"] = String(1 * MB);
    const s = snap({
      memory: { heapUsed: 1000 * MB, heapTotal: 1, heapLimit: 4096 * MB, rss: 2 * MB, external: 0 },
    });
    expect(evaluateHealth(s).status).toBe("critical");
  });

  it("falls back to the default on a malformed value", () => {
    process.env["AGENTMEMORY_HEALTH_CPU_CRITICAL_PERCENT"] = "not-a-number";
    expect(
      evaluateHealth(snap({ cpu: { userMicros: 0, systemMicros: 0, percent: 95 } }))
        .status,
    ).toBe("critical");
  });

  it("honours an overridden count for asserting a verdict", () => {
    process.env["AGENTMEMORY_HEALTH_ASSERT_SAMPLES"] = "2";
    const failed = snap({ connectionState: "failed" });
    let state = evaluateHealth(snap()).hysteresis;
    const seen = [failed, failed].map((s) => {
      const r = evaluateHealth(s, {}, state);
      state = r.hysteresis;
      return r.status;
    });
    expect(seen).toEqual(["healthy", "critical"]);
  });

  it("honours an overridden count for clearing a verdict", () => {
    process.env["AGENTMEMORY_HEALTH_CLEAR_SAMPLES"] = "2";
    let state = evaluateHealth(snap({ connectionState: "failed" })).hysteresis;
    const seen = [snap(), snap()].map((s) => {
      const r = evaluateHealth(s, {}, state);
      state = r.hysteresis;
      return r.status;
    });
    expect(seen).toEqual(["critical", "healthy"]);
  });

  it("treats a count of one as no hysteresis at all", () => {
    process.env["AGENTMEMORY_HEALTH_ASSERT_SAMPLES"] = "1";
    process.env["AGENTMEMORY_HEALTH_CLEAR_SAMPLES"] = "1";
    const state = evaluateHealth(snap()).hysteresis;
    const r = evaluateHealth(snap({ connectionState: "failed" }), {}, state);
    expect(r.status).toBe("critical");
    expect(evaluateHealth(snap(), {}, r.hysteresis).status).toBe("healthy");
  });

  it("honours a threshold explicitly set to zero", () => {
    // Zero is a real setting - it is how an Operator asks to hear about any
    // CPU at all, or disables the RSS floor - not a malformed value (#9).
    process.env["AGENTMEMORY_HEALTH_CPU_WARN_PERCENT"] = "0";
    const s = snap({ cpu: { userMicros: 0, systemMicros: 0, percent: 1 } });
    expect(evaluateHealth(s).status).toBe("degraded");
  });

  it("falls back to the default on an env var set but left empty", () => {
    // `Number("")` is 0, which would read as a deliberate threshold of zero.
    process.env["AGENTMEMORY_HEALTH_CPU_WARN_PERCENT"] = "  ";
    const s = snap({ cpu: { userMicros: 0, systemMicros: 0, percent: 1 } });
    expect(evaluateHealth(s).status).toBe("healthy");
  });

  it("falls back to the default on a sample count of zero", () => {
    // A count of zero would publish every sample unchallenged, which is not
    // hysteresis at all - one is the floor (#9).
    process.env["AGENTMEMORY_HEALTH_ASSERT_SAMPLES"] = "0";
    const state = evaluateHealth(snap()).hysteresis;
    expect(
      evaluateHealth(snap({ connectionState: "failed" }), {}, state).status,
    ).toBe("healthy");
  });

  it("counts a de-escalation as clearing, not asserting (#5)", () => {
    process.env["AGENTMEMORY_HEALTH_ASSERT_SAMPLES"] = "3";
    process.env["AGENTMEMORY_HEALTH_CLEAR_SAMPLES"] = "1";
    let state = evaluateHealth(snap({ connectionState: "failed" })).hysteresis;
    // critical -> degraded lowers the restart signal, so it obeys the clear
    // count and lands on the first sample.
    const r = evaluateHealth(snap({ connectionState: "reconnecting" }), {}, state);
    expect(r.status).toBe("degraded");
  });

  it("does not spend a run toward trouble on the shorter clear count", () => {
    // A run argues in one direction. When a recovering sample turns it around
    // it starts its own run, or a single healthy reading would clear a verdict
    // off samples that were arguing for a worse one.
    process.env["AGENTMEMORY_HEALTH_ASSERT_SAMPLES"] = "5";
    process.env["AGENTMEMORY_HEALTH_CLEAR_SAMPLES"] = "2";
    let state = evaluateHealth(snap({ connectionState: "reconnecting" })).hysteresis;
    for (const s of [
      snap({ connectionState: "failed" }),
      snap(),
    ]) {
      const r = evaluateHealth(s, {}, state);
      state = r.hysteresis;
      expect(r.status).toBe("degraded");
    }
    expect(evaluateHealth(snap(), {}, state).status).toBe("healthy");
  });

  it("reads no signal from a dimension the snapshot does not measure", () => {
    process.env["AGENTMEMORY_HEALTH_MEMORY_WARN_PERCENT"] = "1";
    const s = snap({
      memory: { heapUsed: 4000 * MB, heapTotal: 1, rss: 4000 * MB, external: 0 },
    });
    expect(evaluateHealth(s).status).toBe("healthy");
  });

  it("explicit config still wins over the environment", () => {
    process.env["AGENTMEMORY_HEALTH_CPU_CRITICAL_PERCENT"] = "10";
    const s = snap({ cpu: { userMicros: 0, systemMicros: 0, percent: 50 } });
    expect(evaluateHealth(s, { cpuCriticalPercent: 90, cpuWarnPercent: 80 }).status).toBe(
      "healthy",
    );
  });
});
