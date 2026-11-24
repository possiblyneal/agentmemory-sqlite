# Rank Semantic Facts by explicit conditions (#544)

## Design

- **Baseline:** `90ac0401cba54dc797405610e55868429da487bf`. Use production `recallSemanticFacts` for candidate retrieval, project filtering, and baseline scores. The treatment stable-partitions the returned candidates, promoting exact matches for a final `when …` clause only when the query supplies one. It writes no Facts.
- **Cohort:** Two synthetic pairs of Facts with mutually exclusive conditions and unequal confidence, queried once per condition. Two unqualified queries and one underspecified condition are controls. A matching Fact from another project is a scope control. No private data, model, or holdout used.
- **Pre-measure rule:** More qualified queries rank their independently labeled Fact first, with no qualified loss, unqualified rank change, merged Fact, or scope leak.

## Results

| Arm | Correct first on qualified queries | Control rankings changed | Foreign Facts shown |
|---|---:|---:|---:|
| Production ranking | 2 of 4 | 0 of 3 | 0 |
| Exact condition first | 4 of 4 | 0 of 3 | 0 |

Two paired gains, no losses. Both arms returned the same candidate IDs in each trial; stored Facts were unchanged. The fixtures use literal conditions deliberately; this does not establish accuracy for natural wording, negation, or a desired Fact outside the candidate window.

**Verdict: inconclusive for real Recall.** Retry once paired real queries label both applicable and inapplicable conditions and include ambiguous, negated, and paraphrased conditions at the production candidate cap.

## Reproduction

`npx tsx eval/runner/fact-conditions.ts` reports the paired ranked IDs. `npx vitest run test/eval-fact-conditions.test.ts` checks ranking, scope, and storage preservation.
