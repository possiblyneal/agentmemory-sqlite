# Selected-option query for numbered replies (#535)

## Design

- **Baseline:** `7994deffb87ea768a3800363da6f444c2ec95829`, current reply-tail query through the production `mem::prompt-context` registrar.
- **Treatment:** Narrow the reply to the question and selected option for a bare positive integer matching a contiguous, uniquely numbered list after a single question line. Longer replies, missing or ambiguous choices, and other formats use the unchanged path.
- **Cohort and settings:** Three synthetic choices and four fallback controls, replayed against one fixed in-memory corpus. Both arms use the production BM25 `SearchIndex` behind a `mem::search` adapter and the production Injection renderer. The reranker is off. Labels identify one useful and one rejected-choice-only Observation per selection; score their appearances in rendered text. No private replay or holdout used.
- **Pre-measure rule:** More useful hits and fewer rejected-only hits, with no changed control Injection.

## Paired results

| Measure | Baseline | Treatment |
|---|---:|---:|
| Useful selected-option hits | 3 | 3 |
| Rejected-option-only hits | 3 | 0 |

All four control Injections were unchanged. The treatment met the noise criterion but added no useful hits. Every useful hit already fit in the baseline Injection on this corpus.

**Verdict: inconclusive for real use.** The screen shows the noise reduction but is too sparse and saturated to test the useful-hit gain. Retry with labeled numbered replies where rejected options compete with needed evidence near the output cap, plus multi-line, ambiguous, and unmatched controls. Use paired replay with the normal Injection Gate and prespecify an effect threshold before holdout.

## Reproduction

`npx tsx eval/runner/numbered-replies.ts` prints aggregate counts. `npx vitest run test/eval-numbered-replies.test.ts` checks the fixed pairs. No production source changed.
