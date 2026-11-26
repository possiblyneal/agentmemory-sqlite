# Targeted second read for missed decisions (#533)

## Verdict

**No gain in the synthetic screen; inconclusive for real Sessions.** The second read did not recover the one missing decision, and all Injections were unchanged. Do not ship on this evidence. Retry when the matched checkpoints and frozen decision key are available, with enough eligible baseline omissions to measure recovery. Use dev first and prespecify the real-cohort threshold before holdout.

## Design

- **Baseline:** `83b33f65ade19bebe88c02f143a3f09bec84752a`, unchanged `mem::summarize` through `screenOnePass()`, including its existing retry behavior.
- **Treatment:** Only drafts with at least 8 Observations and at most 3 listed decisions get one extra model call. It reads the same draft and the chronological Operator statements, asks for omissions only, and requires each candidate to cite a verbatim substring from one statement. Accepted text is appended, not substituted. Quote presence is checked mechanically; faithful meaning would be judged separately. All Operator statements were verified present in the baseline model input.
- **Cohort:** Four synthetic Sessions with a frozen key covering 9 needs: format and conditional rules, a correction and export exception, instructions during exploration, and a short ineligible control. Both arms render the production `mem::context` at a 2,000-token budget. Each need is due at the first following SessionStart; hand scoring credits correct meaning in the visible text, including narrative, not reference metadata.
- **Settings:** Serial calls on `general-eval-b` (Occult-Nail-1.0-35B-A3B-UD-Q4_K_XL, one slot, caches off per broker profile), temperature 0, seed 42, 2,048 output-token ceiling. Each pair reuses the same draft. No private data, live memory store, or holdout used.
- **Pre-measure rule:** At least one newly visible valid omitted decision, zero lost decisions, and zero unsupported additions. One run with synthetic inputs does not estimate variability or task outcomes.

## Paired results

| Case | Needed | Draft decisions | Second read? | Baseline visible | Treatment visible | Added model call time (ms) |
|---|---:|---:|---|---:|---:|---:|
| Publishing | 4 | 3 | Yes | 3 | 3 | 730 |
| Warehouse | 2 | 2 | Yes | 2 | 2 | 722 |
| Exploration | 2 | 3 | Yes | 2 | 2 | 771 |
| Short control | 1 | 1 | No | 1 | 1 | 0 |
| **Total** | **9** | | | **8** | **8** | **2,223** |

The first pass omitted the instruction to leave captions unchanged for now; the second read returned an empty list even though it had that statement. Every eligible reply was an empty list, so there were no unsupported additions, quote rejections, or parse errors. No decision was lost. This does not test whether quote validation can reject a plausible but unsupported claim. The first passes took 34,111 ms in aggregate, including the Summarize handler. The three added calls took 2,223 ms of elapsed call time; cost per extra delivered decision is undefined because none were delivered.

## Reproduction limits

This scorecard reports the original research run, including its input checks, model responses, and timings. The baseline is an off-branch research commit. The original runner is not included, and these results were not independently verified for this publication. The real-Session follow-up is #573.
