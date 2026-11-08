import type { RescoreResult } from "./fold-drift-core.js";

export type RunKind = "full" | "screen";

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
export function baselineSessions(rescored: RescoreResult["sessions"], kind: RunKind): BaselineSession[] {
  return rescored.map((s) => ({
    sessionId: s.sessionId,
    keyDecisions: s.keyDecisions,
    neverCaptured: kind === "screen" ? s.keyDecisions - s.inOnePass : s.neverCaptured,
  }));
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

export function stopLine(state: StopState, stoppedEarly: boolean): string {
  const verdict = verdictOf(state.gain, state.threshold);
  return stoppedEarly
    ? `stopped early: ${state.stop}, gain=${state.gain} threshold=${state.threshold} verdict=${verdict}, skipped ${state.skipped.length}: ${state.skipped.join(",")}`
    : `ran all sessions: gain=${state.gain} threshold=${state.threshold} verdict=${verdict}`;
}
