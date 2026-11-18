import type { Probe } from "./replay-score.js";

// The daemon answers a below-floor prompt-submit turn before recording an
// Injection, so those probes are left out; pairing them would shift every later
// probe of the Session onto the next turn's record.
export function pairProbesWithRecords<R extends { source: string }>(
  probes: Probe[],
  records: R[],
  unrecorded: ReadonlySet<Probe>,
): Map<Probe, R | undefined> {
  const paired = new Map<Probe, R | undefined>();
  // Paired per source: a session-start record exists only when the daemon runs
  // with injection on, so position across sources would shift every later probe.
  for (const [kind, source] of [["session-start", "session-start"], ["prompt-context", "prompt-submit"]] as const) {
    const ofKind = probes.filter((p) => p.kind === kind && !p.failed && !unrecorded.has(p));
    const ofSource = records.filter((r) => r.source === source);
    if (ofKind.length !== ofSource.length) {
      console.warn(`  ${source} injection records (${ofSource.length}) do not match probes (${ofKind.length})`);
    }
    ofKind.forEach((probe, i) => paired.set(probe, ofSource[i]));
  }
  return paired;
}
