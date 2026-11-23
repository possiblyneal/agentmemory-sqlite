# Lesson candidate filtering

## Hypothesis

Filtering ineligible Lesson hits before the candidate cut prevents another project's Lessons
from starving a matching Lesson (#438).

## Evidence

The verification reported in #438 compared a prototype with base `fdc3d459`. Its synthetic
reproduction failed before the fix and passed after it; the fast evaluation's 15 metrics were
unchanged. On a read-only store copy, its prompt-submit Lesson pick was unchanged for all
5,588 replayed prompts; filtered recall returned additional same-project Lessons. These are
reported verification results, not a new replay on this branch.

On base `7f20ceddd85cadbbfa03679d451fb4222f607433`, the regression fixture with 200
higher-scoring foreign Lessons failed before this change on `searchLessons` and passed after it
on both Lesson search paths. The fixture also covers deleted and below-confidence candidates.

The post-change `eval:gate` passed. Prompt-submit recall, precision and no-answer cleanliness
were respectively 0.907, 0.889 and 0.833, each unchanged from its gate baseline. The dev
`eval:coding-life` completed; no paired baseline was run in that run.

## Paired synthetic crowding evaluation

The reproducible `eval/lesson-crowding.ts` fixture (documented in `eval/README.md`) compares
actual pre-PR source `7f20ceddd85cadbbfa03679d451fb4222f607433` with the corrected arm.
It expects `target`, a relevant project Lesson behind 200 higher-scoring foreign Lessons.
The pre-PR candidate and recall paths each returned no IDs (0/1); the corrected paths each
returned `target` (1/1). This single synthetic case does not measure general Recall quality.

The review also found the PR's all-hit insertion ranking shifted 100,000,000 array slots per
path on a synthetic 20,000-Lesson corpus. In one corrected run of that same corpus, candidate
ranking shifted 210 slots and recall shifted 5,051 slots. The paths retain corpus-wide BM25
scoring, and Recall normalizes against the highest score even when that hit is ineligible.
