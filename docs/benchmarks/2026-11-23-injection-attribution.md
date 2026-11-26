# Individual Injection attribution (#562)

## Frozen comparison

Baseline `7610844e`. Each synthetic task tests the nominated note against a neutral note in the same position. The broad context, action prompt, model, deadline and output ceiling are fixed within a pair; no mutable checkout is involved. A seeded shuffle determines arm order, with two model seeds per task. Score the JSON action without knowing the arm. Two development tasks each nominate a note from one class; fit an include/withhold choice from these paired outcomes, favoring inclusion on ties. Evaluate the fitted choice against always including on two separate synthetic tasks. These are held-back fixtures, not repository holdout data.

Require a repeated nonzero directional effect across both seeds on at least one development task, at least one fewer held-back action error, no newly stale or lost correct actions, and no more than two prompt tokens of difference per pair. Report repeated disagreements and how the effect changes with broader context; context and task identity vary together, so this does not isolate a context interaction.

Model: local `general-eval-b`, serial, temperature 0, seeds 42 and 43, 2,048-output-token ceiling and 60-second deadline per arm. The test does not execute coding patches or evaluate live Recall selection.

## Results

| Task | Without nominated note | With nominated note |
|---|---:|---:|
| Development Rule; no other decision | 0 of 2 correct | 2 of 2 correct |
| Development legacy; approval pending | 2 of 2 correct | 2 of 2 correct |
| Held-back Rule; confirmed value already present | 2 of 2 correct | 2 of 2 correct |
| Held-back legacy; conflicting confirmed value present | 2 of 2 correct | 0 of 2 correct |

All eight pairs matched prompt token counts exactly. Outcomes agreed across both seeds in each cell. This does not establish variance under a stochastic sampler or on a task population. The learned policy retained both classes, matching always-include at 2 of 4 correct and two stale actions on held-back tasks. A Rule helped when no other decision was supplied but added nothing when the broader context already supplied the answer; the legacy note was harmless on its development task and harmful on the held-back conflict.

**Verdict: rejected for the tested class policy.** The intervention found repeatable task-local effects but did not reduce held-back errors. Retry with multiple independent tasks per class, factorial broad-context controls, and blind scoring of actual coding actions across repeated runs.

Reproduce from the baseline with `npx tsx eval/runner/injection-attribution.ts`; an unchanged baseline and runner can reuse completed rows with `--resume`. `npx vitest run test/eval-injection-attribution.test.ts` checks policy fitting. Raw rows stay local.
