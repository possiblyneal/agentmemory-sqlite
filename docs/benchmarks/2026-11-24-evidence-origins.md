# Count independent evidence origins (#570)

Baseline `c80c6ac4`. Production Semantic Fact Recall supplies the same scoped hits to both synthetic readers. The first reader counts delivered rows per claim; the second counts distinct supplied roots and gives missing lineage no independent vote. Tied counts defer. Representation labels stand in for Observations, Summaries and Insights; this does not run cross-surface retrieval, chain extraction, or a model. The frozen threshold requires fewer wrong actions on copied evidence, no loss on verified corroboration, and neither a new wrong action nor invented independence with incomplete lineage. No repository holdout was used.

| Case | Records counted | Origins counted |
|---|---|---|
| Mistake copied from one root; two independent correct sources | Wrong | Correct |
| Two independently verified sources; one mistaken source | Correct | Correct |
| Two correct reports with unavailable lineage; one known mistaken source | Correct | Wrong |

Both scored 2 of 3: one gain, one loss, one tie. Counting origins did not treat either unknown record as independent, but promoted the mistaken claim once both missing roots were discounted. The experiment deliberately supplies root labels; it does not measure provenance storage or extraction cost.

**Verdict: rejected.** The gain depended on complete lineage. Retry with independently traced cross-surface histories and an uncertainty policy that avoids automatically promoting a minority claim over unresolved evidence.

Reproduce with `npx tsx eval/runner/evidence-origins.ts`; verify with `npx vitest run test/eval-evidence-origins.test.ts`.
