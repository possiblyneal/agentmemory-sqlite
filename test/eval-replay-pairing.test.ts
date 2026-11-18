import { describe, expect, it } from "vitest";
import { pairProbesWithRecords } from "../eval/runner/replay-pairing.js";
import type { Probe, ProbeKind } from "../eval/runner/replay-score.js";

const probe = (kind: ProbeKind, turn: number): Probe => ({ kind, turn, latencyMs: 0, chars: 0, items: [] });
const record = (source: string, id: string) => ({ source, id });

describe("pairProbesWithRecords", () => {
  it("skips a below-floor turn mid-Session, so later turns keep their own records", () => {
    const start = probe("session-start", 0);
    const first = probe("prompt-context", 1);
    const terse = probe("prompt-context", 2);
    const third = probe("prompt-context", 3);
    const records = [record("session-start", "s"), record("prompt-submit", "r1"), record("prompt-submit", "r3")];

    const paired = pairProbesWithRecords([start, first, terse, third], records, new Set([terse]));

    expect(paired.get(start)?.id).toBe("s");
    expect(paired.get(first)?.id).toBe("r1");
    expect(paired.get(third)?.id).toBe("r3");
    expect(paired.has(terse)).toBe(false);
  });

  it("pairs per source, so a missing session-start record does not shift prompt-submit", () => {
    const start = probe("session-start", 0);
    const first = probe("prompt-context", 1);
    const paired = pairProbesWithRecords([start, first], [record("prompt-submit", "r1")], new Set());
    expect(paired.get(first)?.id).toBe("r1");
    expect(paired.get(start)).toBeUndefined();
  });
});
