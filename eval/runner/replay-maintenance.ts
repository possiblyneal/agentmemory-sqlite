// A maintenance pass the replay runs on each restored checkpoint before it is
// probed, to measure what shrinking the store costs Recall. Each pass is one
// REST call; an `evict-*` pass first seeds `mem:config/eviction`, which
// mem::evict merges over its defaults, with the age gates opened so the pass
// acts on a store weeks old as it would on one past them.
export interface MaintenancePass {
  name: string;
  path: "evict" | "auto-forget";
  eviction?: Record<string, number>;
}

// Recovering a stale Session without a Summary calls the LLM, which a probe
// pass does not have; the evict-* passes keep it out of what they measure.
const NO_STALE_SESSIONS = 36_500;

export function parseMaintenance(spec: string): MaintenancePass | { error: string } {
  if (spec === "evict" || spec === "auto-forget") return { name: spec, path: spec };
  const match = spec.match(/^(evict-importance|evict-cap):(\d+)$/);
  if (!match) {
    return { error: `--maintenance must be evict, auto-forget, evict-importance:N or evict-cap:N, got: ${spec}` };
  }
  const n = Number(match[2]);
  if (match[1] === "evict-importance") {
    return {
      name: spec,
      path: "evict",
      eviction: { staleSessionDays: NO_STALE_SESSIONS, lowImportanceMaxDays: 0, lowImportanceThreshold: n },
    };
  }
  if (n < 1) return { error: `evict-cap needs a cap of at least 1, got: ${spec}` };
  return { name: spec, path: "evict", eviction: { staleSessionDays: NO_STALE_SESSIONS, maxObservationsPerProject: n } };
}
