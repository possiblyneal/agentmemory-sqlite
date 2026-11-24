# Split unresolved Compression batches (#548)

## Design

- **Baseline:** `0ef0169b` runs the production Compression registrars. The isolated treatment sends four or more unresolved Observations through two smaller batches before individual fallback. It uses the same parser and ownership checks for each batch and does not send already-validated Observations again.
- **Cohort:** Three paired fixtures of six Observations each: recoverable partial reply; partial reply with more repeated and unknown IDs on split; provider exception from the initial call. The first two fixtures share an initial reply containing two valid items, a duplicated expected ID and an unknown ID. The malformed split also returns an ID already credited on the initial call. Provider replies are scripted by requested input; no real model, private data, or holdout was used.
- **Pre-measure rule:** Fewer calls overall and no additional absent rows, wrong attribution, or later model-completed Observations. Completion is measured at the call on which the row is written, with one serial provider slot and equal virtual cost per call, not wall time.

## Results

| Fixture | Calls, individual → split | Additional later completions | Parked, individual → split |
|---|---:|---:|---:|
| Recoverable partial reply | 5 → 3 | 0 | 0 → 0 |
| Malformed split replies | 5 → 6 | 3 | 0 → 0 |
| Initial provider exception | 1 → 1 | 0 | 6 → 6 |

Total calls fell from 11 to 10. Neither arm lost a row, committed a wrong fixture marker, or rewrote a validated item. The initial provider exception left all six synthetic rows parked for retry in both arms. The test detects unknown and repeated IDs; it does not establish that a well-formed reply with the right ID and the wrong content can be detected.

**Verdict: rejected for splitting every qualifying partial batch.** Retry if a split selector can be shown prospectively to avoid the added delays in malformed replies; compare on matched provider traces with per-Observation completion times and attribution labels.

## Reproduction

`npx tsx eval/runner/batch-split.ts` runs the paired fixtures. `npx vitest run test/eval-batch-split.test.ts` checks the call savings, malformed-reply regression, attribution, and outage control.
