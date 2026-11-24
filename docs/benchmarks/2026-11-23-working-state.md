# Working state after interruption (#563)

## Frozen comparison

Baseline `5587cd1a`. The ordinary continuation uses the production `mem::context` renderer against a synthetic stored Summary. The prototype derives a brief from that task's typed conversation and tool-result events, marking verified revision/check state as observed and next action or unresolved proposals as inferred. Exact scripted next-action readers score the arms against a separate state key. Cases cover a completed edit missing from the Summary, a passing check for an older revision, and a plan without any edit. Require fewer repeats and missed constraints, no added invented progress or pending work, and no lost correct next actions. Record local synthesis time and estimated tokens, including serialization. No model, live store, or holdout is used; note presence and exact next-action scores are proxies.

## Results

| Metric | Summary continuation | Reconstructed state |
|---|---:|---:|
| Correct next action | 1 of 3 | 3 of 3 |
| Repeated edit | 1 | 0 |
| Missed constraint | 1 | 0 |
| Stale check treated as current | 1 | 0 |
| Estimated tokens | 232 | 186 |

The earlier passing check became stale after the observed revision changed. The proposed but unperformed edit remained inferred, not an observed completion, in the prototype. Total local synthesis and serialization time was about 0.111 ms. Event extraction, tool-result parsing, and actual Agent performance were not measured.

**Verdict: inconclusive beyond the synthetic screen.** The prototype met its proxy thresholds with supplied typed events and revision IDs. Retry with real interrupted tasks whose independent state keys distinguish proposals, completed edits, stale results and unresolved checks; measure parsing cost and blind actual next actions.

Reproduce with `npx tsx eval/runner/working-state.ts`; `npx vitest run test/eval-working-state.test.ts` checks stale-check and inferred-work handling.
