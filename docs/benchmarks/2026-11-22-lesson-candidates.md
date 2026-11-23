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
`eval:coding-life` completed; no paired baseline was run in this session.
