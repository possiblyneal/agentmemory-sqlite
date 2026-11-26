# Literal excerpts in place of covering Summaries (#538)

## Design

- **Baseline:** `555d9d37ed846c8871f6ca8268a63fe5db237a0b`, unchanged `mem::prompt-context`.
- **Treatment:** A guarded, isolated build replaces the first eligible covered hit with a sentence from its Observation when the prompt quotes a literal present in that sentence but absent from the Summary decisions. Search order, admission, and other rendered items stay unchanged.
- **Cohort:** Four synthetic paired prompts over eligible winning Observations with covering Summaries: exact detail only, exact detail plus a surrounding decision, a literal already present in the Summary, and an unquoted decision. A fixed search adapter holds rank constant and the reranker is off. Every reply fits the same 200 estimated-token ceiling. Score whether the correct answer evidence is visible, not an Agent's answer. No private replay or holdout used.
- **Pre-measure rule:** More visible exact details with no lost surrounding decisions and unchanged controls.

## Results

| Needed evidence | Baseline | Treatment |
|---|---:|---:|
| Exact details visible | 1 of 3 | 3 of 3 |
| Surrounding decisions visible | 3 of 3 | 2 of 3 |

Both controls were unchanged. In the combined-detail case, the treatment supplied the error literal but removed the instruction on what to do after the error.

**Verdict: rejected in the synthetic screen.** Replacing the Summary can fix the literal miss and cause a decision miss on the same turn. Retry with a same-budget candidate that can preserve both and a paired replay containing independently labeled exact and combined needs. Downstream answer accuracy was not measured.

## Reproduction

`npx tsx eval/runner/literal-excerpt.ts` prints paired counts; `npx vitest run test/eval-literal-excerpt.test.ts` verifies the fixture. The prototype is built under `tmp/literal-excerpt/`. Production source is unchanged.
