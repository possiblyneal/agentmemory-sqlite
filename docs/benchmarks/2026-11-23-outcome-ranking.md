# Recall ranking from task outcomes (#557)

## Frozen comparison

Baseline `e17ec709`. The unchanged BM25-backed `mem::search` supplies two project-scoped candidate Observations per synthetic task. The baseline takes the first hit. The treatment ranks the same hits by observed development action success for their Observation type, with current order breaking ties. Both expose exactly one whole, unlabelled note. Eight development Sessions each receive one exposure assigned by a seeded shuffle with four of each type. Four separate frozen synthetic Sessions run both arms in alternating order. The scorer accepts only a JSON action with the expected value; it sees neither arm nor rank. An action that selects the outdated value counts as stale. The scorer does not run model-generated code.

Require at least two net additional correct actions in the four pairs, no newly stale actions, the same one-note cap and 60-second model deadline, no more than one prompt token of difference per pair, and under 10 ms incremental ranking cost in every pair. This is a small synthetic test, not the repository holdout or an independent real coding cohort. The synthetic correlation between the Observation type and correctness is part of the test design.

The local `general-eval-b` profile runs serially, with temperature 0, seed 42 and a 2,048-output-token cap. The fixture keeps the expected value out of the task prompt and the arm out of the action scorer. The AI host had 82 GiB available before warmup and 54 GiB after the probe and after the cohort.

## Results

| Metric | Current Recall | Outcome-trained ranking |
|---|---:|---:|
| Correct actions | 2 of 4 | 3 of 4 |
| Stale actions | 2 of 4 | 1 of 4 |
| Prompt tokens per action | 226 | 226 |
| Total model call time | 31,159 ms | 37,537 ms |

Development yielded 4 of 4 correct actions after exposure to a `decision` and 1 of 4 after exposure to a `file_edit`, so the trained policy preferred `decision`. The paired test yielded two wins, one loss and one tie; the loss introduced a stale action, even though aggregate stale actions decreased. Maximum added reranking time was 0.105 ms. These short selection measurements do not establish daemon latency, and the model times are descriptive, not a causal estimate of the ranking cost.

**Verdict: rejected for the tested two-type policy.** It gained one correct action rather than the required two and introduced a stale action. Retry with randomized exposures on replayable coding tasks and a policy that conditions on evidence validity rather than record type alone, tested against blind action or patch judgments in separate Sessions.

Reproduce from the baseline with `npx tsx eval/runner/outcome-ranking.ts`; use `--resume` with an unchanged baseline and runner to reuse completed rows. `npx vitest run test/eval-outcome-ranking.test.ts` checks ranking and scoring without a model. Trial rows remain local.
