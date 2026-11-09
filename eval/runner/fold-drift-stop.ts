import type { RescoreResult } from "./fold-drift-core.js";
import type { RunMode } from "./fold-drift-resume.js";

export interface LabelledResult {
  sessionId: string;
  labels?: Array<{ label: string; inOnePass?: boolean }>;
}

export interface BaselineSession {
  sessionId: string;
  keyDecisions: number;
  neverCaptured: number;
}

export type StopReason = "cleared" | "unreachable";

export interface StopState {
  threshold: number;
  gain: number;
  stop: StopReason | null;
  skipped: string[];
}

// The baseline's count for a Session, on the scale the arm's run reports. A full run's
// never-captured is in neither list; a screen's is not in the one-pass list, so a screen
// is compared with the baseline's not-in-one-pass count.
export function baselineSessions(rescored: RescoreResult["sessions"], mode: RunMode): BaselineSession[] {
  return rescored.map((s) => ({
    sessionId: s.sessionId,
    keyDecisions: s.keyDecisions,
    neverCaptured: mode === "screen" ? s.keyDecisions - s.inOnePass : s.neverCaptured,
  }));
}

// The arm's count per finished Session, on the baseline's scale. A full run counts a key
// decision in neither the one-pass nor the final folded list, as the re-score does, so one a
// fold held and the last step dropped counts only when the one pass missed it too.
export function armCounts(finished: LabelledResult[], mode: RunMode): Map<string, number> {
  const missed =
    mode === "screen"
      ? (l: { label: string }) => l.label === "never-captured"
      : (l: { label: string; inOnePass?: boolean }) => l.label !== "kept" && !l.inOnePass;
  return new Map(finished.map((r) => [r.sessionId, (r.labels ?? []).filter(missed).length]));
}

// Most never-captured first; Sessions with equal counts keep their given order.
export function orderByBaseline(sessions: BaselineSession[]): BaselineSession[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.neverCaptured - a.s.neverCaptured || a.i - b.i)
    .map(({ s }) => s);
}

// `armCounts` holds the arm's never-captured count for each finished Session. Gain is the
// baseline's count minus the arm's, summed over those. The arm wins when gain reaches
// `threshold`; a gain short of it, ties included, stays with the baseline.
// `stop` is set only while Sessions remain, and only when no outcome of the unfinished Sessions can change the verdict: an arm count
// lies between 0 and the Session's key decisions, so each unfinished Session adds at most
// its baseline count and subtracts at most the key decisions the baseline captured.
export function stopState(ordered: BaselineSession[], armCounts: ReadonlyMap<string, number>, threshold: number): StopState {
  let gain = 0;
  let mostToGain = 0;
  let mostToLose = 0;
  const skipped: string[] = [];
  for (const s of ordered) {
    const arm = armCounts.get(s.sessionId);
    if (arm === undefined) {
      mostToGain += s.neverCaptured;
      mostToLose += s.keyDecisions - s.neverCaptured;
      skipped.push(s.sessionId);
    } else {
      gain += s.neverCaptured - arm;
    }
  }
  const stop: StopReason | null =
    skipped.length === 0 ? null : gain - mostToLose >= threshold ? "cleared" : gain + mostToGain < threshold ? "unreachable" : null;
  return { threshold, gain, stop, skipped };
}

export const verdictOf = (gain: number, threshold: number): "cleared" | "not cleared" =>
  gain >= threshold ? "cleared" : "not cleared";

export interface StopReport {
  stoppedEarly: boolean;
  stopReason: StopReason | null;
  gain: number;
  threshold: number;
  verdict: "cleared" | "not cleared" | "undecided";
  skipped: string[];
  failed: string[];
}

// A failed Session counts as unfinished, so the verdict stands only when its outcome could
// not change it (`state.stop`); otherwise the run is undecided.
export function stopReport(state: StopState, stoppedEarly: boolean, failed: string[]): StopReport {
  return {
    stoppedEarly,
    stopReason: stoppedEarly ? state.stop : null,
    gain: state.gain,
    threshold: state.threshold,
    verdict: failed.length > 0 && !state.stop ? "undecided" : verdictOf(state.gain, state.threshold),
    skipped: stoppedEarly ? state.skipped : [],
    failed,
  };
}

export function stopLine(r: StopReport): string {
  const failed = r.failed.length > 0 ? `, failed ${r.failed.length}: ${r.failed.join(",")}` : "";
  return r.stoppedEarly
    ? `stopped early: ${r.stopReason}, gain=${r.gain} threshold=${r.threshold} verdict=${r.verdict}, skipped ${r.skipped.length}: ${r.skipped.join(",")}${failed}`
    : `ran all sessions: gain=${r.gain} threshold=${r.threshold} verdict=${r.verdict}${failed}`;
}
