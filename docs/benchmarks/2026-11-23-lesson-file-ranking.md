# Exact-file Lesson ranking (#554)

## Design

- **Baseline:** `424b0e3d`. `searchLessons` supplies the same BM25-ranked, project-eligible pool to both arms, with its near-twin cap and a pool limit of 10. Control takes its first Lesson; treatment stably promotes Lessons with a tag exactly equal to the supplied project-relative file path and takes the first. Both have a one-Lesson output budget. This is an isolated adapter, not a production change. The pool limit of 10 differs from a direct `searchLessons(..., 1)` call, so it is a ranking proxy, not a measurement of that exact call.
- **Path knowledge:** The harness supplies the task file separately; it does not extract or infer it from the query. No path leaves the ranking unchanged. Exact string equality avoids matching a path substring; the input assumes canonical relative paths and does not test normalization.
- **Cohort:** Four paired synthetic cases, with relevance assigned from the task's stated need rather than rank: an exact-file need with an unrelated directory-tagged Lesson, a needed directory-wide rule with an unrelated exact-file Lesson, a missing path, and a longer different path. A same-wording foreign-project Lesson shares the exact path; each pool excludes it. No private data or holdout was used.
- **Decision rule fixed by the request before measurement:** at least one additional relevant Lesson and fewer unrelated Lessons overall, zero lost needed directory-wide guidance, and no scope regressions. The no-path control must stay unchanged. The cases are constructed illustrations, not a representative or independently sampled cohort.

## Results

| Paired outcome | Control | Treatment |
|---|---:|---:|
| Relevant top Lesson, two labeled need cases | 1 of 2 | 1 of 2 |
| Unrelated top Lesson, two labeled need cases | 1 of 2 | 1 of 2 |
| Needed directory-wide guidance selected | 1 of 1 | 0 of 1 |
| Foreign-project Lessons in pools | 0 | 0 |

There was one paired gain and one paired loss. Both path controls were unchanged. Treatment traded the directory rule for the exact-file Lesson in the directory-need case. The synthetic labels are task-specific: an exact path alone does not imply relevance.

**Verdict: rejected for unconditional promotion.** The zero-loss threshold fails. Retry with a candidate that preserves directory-wide guidance and an independently labeled real task cohort, including ambiguous and cross-project cases. The ranked Lesson is a proxy: no Injection Gate, hook, actual Agent action, or task outcome was measured. No holdout was examined.

## Reproduction

`npx tsx eval/runner/lesson-path-ranking.ts` prints each paired ranking and eligible pool. `npx vitest run test/eval-lesson-path-ranking.test.ts` checks the fixed expected rankings and controls.
