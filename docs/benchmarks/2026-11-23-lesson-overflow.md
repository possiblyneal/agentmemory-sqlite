# Session-start Lesson overflow (#555)

## Verdict

**Rejected for this candidate.** The synthetic counterexample gains a whole relevant Lesson but displaces needed Observation text. This violates the zero-displacement criterion. The small, deliberately pressured cohort does not estimate real-world frequency or Agent outcomes; no production change is proposed.

## Design

- **Baseline:** `b649b1a3`, unchanged `mem::context`. The existing pinned-share pass selects a ranked *prefix* of whole Lessons, not independently fitting entries: if even the first does not fit the share, it puts the full block in recency order. The final loop skips a non-slot block that exceeds the remaining budget. Thus the proposed overflow is reachable, without inventing a baseline failure.
- **Treatment:** an isolated bundle changes only final overflow handling of the existing Lesson block. It scans the block's already-ranked entries, skips those that do not fit, and renders fitting entries whole with the existing heading, estimator, and source IDs. Rules and all other block ordering are unchanged. The exact seam is guarded against source changes.
- **Cohort:** four paired synthetic in-memory cases: an oversized top Lesson and a shorter needed Lesson; a non-overflow control; the same pressure with a needed older Observation; and a small top Lesson followed by an oversized and another small Lesson. Each includes the same pinned Rule. Both arms use identical inputs and a 180-token budget, except the prefix control uses 300; these are intentionally smaller than normal session start. Score the exact returned text, not metadata or Agent behavior.
- **Decision rule:** at least one additional complete relevant Lesson at the same budget, with zero lost pinned Rules, truncated claims, or displaced needed content. This is a synthetic screen, not an effect-size estimate. No holdout was examined.

## Results

| Measure | Baseline | Treatment | Paired change |
|---|---:|---:|---:|
| Short relevant Lesson in pressure cases | 0/2 | 2/2 | 2 gained, 0 lost |
| Needed Observation in counterexample | 1/1 | 0/1 | 0 gained, 1 lost |
| Pinned Rule | 4/4 | 4/4 | 0 lost |
| Non-overflow output | unchanged | unchanged | identical |
| Prefix control | first only | first only | identical |

The long Lesson is omitted whole in both pressure outputs; the short Lesson is complete. Estimated tokens baseline → treatment are 95 → 136 (pressure), 147 → 147 (control), and 162 → 136 (counterexample), all within 180. The test establishes these fixture properties only; it does not measure arbitrary claim truncation, slot pressure, latency, live relevance or task correctness.

The earlier #532 experiment also found that shorter startup content could gain one needed decision while losing a needed file name; this experiment measures a different final-packing lever and independently finds a displacement counterexample.

Retry with a candidate that preserves needed competing content, then use independently labeled matched real checkpoints with realistic budgets and a prespecified dev/holdout threshold. The related #532 scorecard records that a matched archived decision-key cohort was unavailable to its run; no such cohort was used here.

## Reproduction

Run `npx tsx eval/runner/lesson-overflow.ts` and `npx vitest run --project shared test/eval-lesson-overflow.test.ts`. The prototype is built under `tmp/lesson-overflow/`; production source and the live store are untouched.
