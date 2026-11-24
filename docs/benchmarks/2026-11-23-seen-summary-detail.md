# Exact detail after a seen Summary (#556)

## Design

- **Baseline:** `c5a7b467`, production `mem::prompt-context` and Injection Records with a fixed, project-filtered synthetic search hit. The Gate is off. Both arms use the same project, three-result cap and 200 estimated-token ceiling; neither modifies Summary coverage.
- **Treatment:** An eval-only adapter removes the seen Summary ref from reads and renders at most its one matching Observation instead of the covered Summary. It uses the fixture's oracle-labeled answer text to check the *actual first response text* for prior delivery, and matches a quoted question literal in the Observation. This literal match is not an oracle for applicability: it cannot determine whether the condition is correct. The adapter masks the Summary only during treatment reads; it does not update stored coverage. Injection Records suppress a repeated Observation.
- **Cohort:** Three synthetic pairs: novel needed detail, an already-visible answer, and an online question whose matching Observation applies only offline. Each pair first requires an actual Summary ref and visible prior text, then probes twice. No live Recall, model, Agent answer, private data, or holdout was measured.
- **Pre-measure rule:** Gain at least one needed exact detail, with zero unnecessary repeats and zero newly unsupported or wrong evidence. The tolerances were fixed in the runner before output.

## Results

| Measure | Baseline | Treatment |
|---|---:|---:|
| Needed answer text visible across prior and new Injection | 1 of 2 | 2 of 2 |
| Wrong-condition answer text newly injected | 0 of 1 | 1 of 1 |
| Observation repeated on subsequent probe | 0 of 3 | 0 of 3 |

The already-visible control added nothing. The novel case gained its needed text, but a literal match also admitted an offline condition in response to an online question. This is evidence of text availability and a wrong-condition risk, not an Agent's answer or live retrieval performance.

**Verdict: rejected for this literal rule.** Retry with a candidate that avoids wrong-condition evidence and independently labeled, paired real tasks with matched scope and budget; measure actual answers as well as delivery.

## Reproduction

`npx tsx eval/runner/seen-summary-detail.ts` runs the pairs; `npx vitest run test/eval-seen-summary-detail.test.ts` checks the aggregate controls.
