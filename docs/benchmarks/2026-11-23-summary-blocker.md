# Prioritize Summary-blocking Compression (#547)

## Design

- **Baseline:** `20c1a44296eb2893f20a3eb0b00c321df188774f`. Both arms call production `mem::recompress-orphans` and `mem::summarize` over an in-memory store. The control sees pending entries in insertion order, as in SQLite; the treatment moves the known oldest blocker for the waiting Session ahead of other parked retries. It leaves the sweep's raw-orphan priority untouched; there are no raw orphans in this cohort. Normal per-Session batch enqueue and flush are a separate path and were not changed or measured.
- **Cohort:** Three paired synthetic backlogs with 2, 4, or 6 unrelated pending jobs and one blocker, then four unrelated arrivals. Each arm has one serial retry slot, a sweep limit of 2, sweeps every 10 virtual seconds, two virtual seconds per attempt including the late job's scripted first timeout, and a Summary probe five seconds after each sweep. The Summary model is a scripted reply with no simulated provider contention. Stop at virtual second 80. No real model, history, or holdout used.
- **Pre-measure rule:** Reduce median covered-decision delay by at least one 10-second probe interval, with no additional timeouts or unfinished background jobs and no increase in any paired backlog's maximum background completion delay. A decision in partial Summary text does not suffice: its Observation must pass production `summaryCovers()`.

## Results

| Initial unrelated jobs | Covered decision, baseline → priority (virtual s) | Maximum unrelated completion delay, baseline → priority (virtual s) |
|---|---:|---:|
| 2 | 15 → 5 | 12 → 12 |
| 4 | 25 → 5 | 14 → 22 |
| 6 | 35 → 5 | 24 → 32 |

Median time to coverage dropped from 25 to 5 virtual seconds; the slowest pair dropped from 35 to 5. The text was already present at the initial probe in both arms, with no coverage. All 24 unrelated jobs completed in each arm, and each arm timed out 3 times across the pairs. Both arms used two Summary model calls per backlog. This measures displacement under the specified capped sweep, not live latency or starvation under indefinite load.

**Verdict: rejected for unconditional priority within parked retries.** Retry if a bounded priority rule avoids the measured background-tail regression, and compare it under observed mixed backlog arrivals and shared provider capacity, with both normal batch flushes and retry sweeps.

## Reproduction

`npx tsx eval/runner/summary-blocker.ts` prints the paired measurements. `npx vitest run test/eval-summary-blocker.test.ts` verifies coverage timing and the background regression.
