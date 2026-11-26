# Retained source evidence during a Summary gap (#551)

## Design

- **Baseline:** `045edfb6`. Production Summarize consumes six synthetic Observations in three chunks. A scripted provider returns invalid XML on both attempts at the middle chunk; the partial Summary stops its coverage at that chunk. Each pair retries the same inputs and verifies that coverage advances. Neither arm changes coverage or Eviction.
- **Treatment:** In the paired prompt-context trial, admit one ranked Observation outside the watermark despite its Summary having already been seen. Label it as source evidence, not a verified requirement. Both arms use the same project-scoped Search fixture and the Gate is off. The fixture chooses the strongest hit; this does not evaluate live Search rankings.
- **Cohort and pre-measure rule:** Three synthetic pairs: necessary source evidence after a prior Summary Injection, a superseded proposal as the strongest hit after a prior Summary Injection, and an unseen-Summary control. Require more correct answers available as text, no added stale or misrepresented claims, and no retained Observation carried over after coverage recovers. No Agent actions, private data, or holdout were used.

## Results

| Metric | Current Recall | Labeled retained evidence |
|---|---:|---:|
| Correct answer text before retry | 1 of 3 | 2 of 3 |
| Superseded proposal returned before retry | 0 of 3 | 1 of 3 |
| Additional raw evidence after retry | 0 of 3 | 0 of 3 |

Treatment added one useful Observation and one superseded proposal. Both new fragments were labeled as evidence, not requirements; the label did not remove the obsolete choice from the supplied text. The unseen control was unchanged. After the retry, a fresh Session received the recovered Summary in every pair, with no raw evidence carryover in the original or fresh Session.

**Verdict: rejected for the one-hit rule at zero stale-evidence tolerance.** Retry when the fallback can reject superseded proposals in the uncovered interval and can be evaluated on matched real failure intervals with independently judged answers.

## Reproduction

`npx tsx eval/runner/summary-gap-evidence.ts` prints the pairs. `npx vitest run test/eval-summary-gap-evidence.test.ts` verifies the middle-chunk failure, fallback, and post-retry coverage behavior.
