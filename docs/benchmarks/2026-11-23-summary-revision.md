# Re-inject revised Summary decisions (#549)

## Design

- **Baseline:** `60e47c1c`, production `mem::prompt-context` and Injection Record writes over an in-memory store. The treatment's read adapter admits an already-seen Summary only if its visible decision list differs from the list delivered most recently. It compares the decisions after the production count and per-decision caps. Both arms use the same project-filtered Search fixture, with the Injection Gate off.
- **Cohort:** Four paired synthetic cases, each with an initial Injection, a probe after the revision, and a repeat probe: changed visible decision, unchanged Summary, metadata-only revision, and a change below the render cap. The action proxy applies the latest visible manifest choice. No model, edits, private data, or holdout were used.
- **Pre-measure rule:** Fewer stale proxy choices, no repeated delivery of unchanged decisions, and no additional estimated context tokens on the control probes.

## Results

| Metric | Seen Summary ID | Compare visible decisions |
|---|---:|---:|
| Stale choices | 1 of 4 | 0 of 4 |
| Second-probe tokens in the changed case | 0 | 222 |
| Second-probe tokens across the unchanged, metadata-only, and below-cap controls | 0 | 0 |
| Third-probe tokens across all cases | 0 | 0 |

The changed case was the only paired gain. It sent a full Summary block, including unchanged lines; the next probe sent nothing. This tests whether the new decision arrives, not whether an Agent follows it. The treatment keeps the delivery fingerprint only in the trial adapter, so the run does not verify cross-process history, restart behavior, or legacy Injection Records.

**Verdict: inconclusive for real Agent actions.** Retry on matched replay with already-delivered decisions that actually change and independently judged subsequent actions; include amendments, legacy records, and full-block token cost.

## Reproduction

`npx tsx eval/runner/summary-revision.ts` prints the trial. `npx vitest run test/eval-summary-revision.test.ts` verifies the stale proxy and unchanged controls.
