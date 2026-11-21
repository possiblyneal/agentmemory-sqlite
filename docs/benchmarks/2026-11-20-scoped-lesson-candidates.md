# 2026-11-20 — scoped Lesson candidates

## Hypothesis and change

Other projects' higher BM25 hits can exhaust the candidate cut before an eligible Lesson is considered. Search the full Lesson index, filter for project, live status and minimum confidence, then apply the existing candidate cut and near-twin ranking. Global Lessons remain visible to scoped searches; unscoped searches span projects. The full-index ranking can cost more on large stores.

## Checks on pinned base `d309ec74`

- The focused Lesson tests pass: 57 tests in two files, including 250 higher-scoring other-project hits on both paths, global and unscoped visibility, and tombstone and confidence filtering. Typecheck passes.
- The BM25 coding-life gate passes on instance 91, all quality metrics equal to baseline. Prompt-submit recall is 0.907, precision 0.889, no-answer clean 0.833, p95 7 ms. The pinned-rules gate also passes, session-start p95 3 ms and pre-compact p95 2 ms.
- The BM25 gate runs without the prompt Lesson reranker and cannot measure Lesson Injection quality. Full suite, broker-backed and holdout evals were not run here.

## 2026-11-21 — comparison against `main`

Both arms used the same read-only store copy (415 Lessons) and 5,591 paired project/prompt inputs with the same project resolver. The control was `main` at `929ccc12`; the candidate was the combined local tree for #479, #439, #436 and #438 (`0e1cbcd0`), not #438 in isolation.

| Metric | Main | Candidate |
| --- | ---: | ---: |
| Lesson Recall results returned | 17,253 | 17,790 |
| Mean Lesson Recall call | 0.602 ms | 0.843 ms |
| Mean prompt-submit BM25 Lesson selection | ≈0.694 ms | ≈0.694 ms |

Prompt-submit BM25 Lesson top-1 was unchanged on all 5,591 prompts. Lesson Recall added 866 same-project results across 388 prompts and displaced 329 live same-project results across 225 prompts. All displaced results were previously at ranks 4–10, with 271 at ranks 9–10. No Global or other-project result entered or left a list. The combined build passed 3,183 tests (1 skipped), typecheck and both BM25 Recall gates.

This measures which Lessons were returned, not their usefulness or end-to-end reranked Injection quality. The change remains local.

## Earlier verdict on `fdc3d459`

The [#438 verdict](https://github.com/possiblyneal/agentmemory-sqlite/issues/438#issuecomment-6984901342), on `fdc3d459`, reported the original three regression tests failing on base and passing with the proposed fix, typecheck, 3,119 tests and both gates passing, and all 15 fast-suite metrics unchanged. On a read-only copy of the Operator's store (415 Lessons, 5,588 replayed prompts), the prompt Lesson top-1 was unchanged; recall gained 902 same-project Lessons on 211 prompts and displaced 335 on 229 prompts, all from ranks 4–10. No Global or other-project Lesson entered or left a list. This earlier measurement did not include the additional tombstone filter in this implementation.

The earlier [prompt-submit Lesson measurement](./2026-11-11-prompt-submit-lessons.md) explains why BM25-only gates do not measure injected Lessons. No live store was accessed for this implementation.
