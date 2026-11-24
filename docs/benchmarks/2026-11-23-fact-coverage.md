# Semantic Fact coverage ranking

## Frozen decision rule

Before running either arm, require at least one additional correct first hit on specific questions, zero newly unsupported or wrong first hits in paired changes across all questions, and no control or project-scope regressions. A first hit is a retrieval proxy, not an Agent answer. The synthetic cohort is a diagnostic, not a representative holdout; a positive result alone cannot establish production benefit.

## Method

Baseline revision `44a05935`; five hand-authored synthetic paired queries, each with the same in-memory Facts and Session scope in both arms. `eval/runner/fact-coverage.ts` calls the real `recallSemanticFacts` with limit 1 and project scope. The treatment bundles an isolated copy of the same source under the worktree's `tmp/`, replacing only queried scoring with matched-term count plus half confidence. This orders by matched count, then confidence for confidence values in the fixture. Both arms retain alias matching, project filtering and the near-twin cap; no condition matching is added. The cap may demote an older high-coverage hit after pool selection, so coverage-first is not an unconditional final ordering. Neither alias behavior nor the 50-candidate cutoff is separately stress-tested here.

## Results and verdict

| Paired outcome | Count |
|---|---:|
| Specific first hit changed from unsupported to correct | 1 |
| Correct first hit changed to wrong | 1 |
| Ambiguous, no-match, and foreign-project controls unchanged | 3 |

**Rejected:** the gain is accompanied by a new wrong first hit, violating the frozen tolerance even though controls held. Retry if a coverage-first candidate avoids that wrong-answer pairing and independently labeled real queries and Facts support a paired evaluation. The sample is constructed to expose the ranking tradeoff; it does not estimate its real-world frequency or Agent task accuracy.

Reproduce with `npx tsx eval/runner/fact-coverage.ts`; `npx vitest run test/eval-fact-coverage.test.ts` checks the paired outputs.
