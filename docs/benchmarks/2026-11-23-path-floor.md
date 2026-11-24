# Exact paths below the Injection word floor (#546)

## Design

- **Baseline:** `07d9978e2e931b3fb87ffae178b27e1f62b57019`. The control returns empty below the word floor. For otherwise-below-floor turns, the isolated registrar treatment admits only hits whose file list contains the exact project-relative path typed in the prompt. It leaves the production Gate and its fail-open behavior intact. A project-scoped Search adapter supplies ranked candidates; the separate REST word-floor check is not part of this trial.
- **Cohort:** Six paired synthetic turns: two needed decisions, an irrelevant exact match, a path present in a foreign project and under a different local directory, a no-path prompt, and an irrelevant exact match with a Gate error. Scripted loopback Gate scores are fixed; no model, private data, or holdout used.
- **Pre-measure rule:** More needed decisions rendered, with no additional irrelevant Injection on any no-answer turn and no scope or no-path change.

## Results

| Arm | Needed decisions rendered | Irrelevant Injections | Wrong-directory or foreign results |
|---|---:|---:|---:|
| Word floor | 0 of 2 | 0 of 4 | 0 |
| Exact path admitted | 2 of 2 | 1 of 4 | 0 |

Both answers were paired gains. The healthy Gate rejected an irrelevant exact match; the error case delivered that match through the existing fallback. The same-basename and no-path controls stayed empty. The supplied Search adapter does not measure whether real Recall finds all exact-path candidates.

**Verdict: rejected for admission with the unchanged fallback.** Retry if a candidate keeps the below-floor path exception empty on failed or unavailable Gate responses without changing normal fail-open behavior. Then use paired real path-led turns, including no-answer paths, through the REST and hook surfaces.

## Reproduction

`npx tsx eval/runner/path-floor.ts` runs the paired trials with a loopback Gate. `npx vitest run test/eval-path-floor.test.ts` checks the expected answers and no-answer behavior. The isolated build is written under `tmp/path-floor/`.
