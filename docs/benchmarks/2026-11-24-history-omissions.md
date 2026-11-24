# Full-history replay for compact Memory omissions (#566)

## Comparison

Baseline `24aa4830`. The compact arm sees a hand-written compact note; the full arm sees original synthetic conversation events, restricted to the same project and strictly before the task turn. If full succeeds where compact fails on development and an approval was available, add exact pre-turn approval lines to the held-back compact arm. The rule uses synthetic event labels, not text extraction. The cohort has two development and three held-back tasks, including no approval, a future amendment, and a foreign approval. Neither the model prompt nor the exact JSON action scorer gets the arm label. All calls use single-slot `general-eval-b`, temperature 0, seed 42, and a 2,048-output-token ceiling. Arm order rotates. This is not the repository holdout.

Require at least one additional correct held-back action over compact alone with no lost correct action or added stale action. Score full history independently rather than treating it as ground truth. Count prompt and completion tokens, and elapsed call time for the offline arm.

## Results

| Cohort and arm | Correct | Stale errors | Prompt tokens | Completion tokens | Call time (ms) |
|---|---:|---:|---:|---:|---:|
| Development · compact | 1 of 2 | 1 | 462 | 913 | 46,579 |
| Development · full | 1 of 2 | 1 | 463 | 1,658 | 74,240 |
| Held-back · compact | 1 of 3 | 0 | 690 | 1,763 | 68,029 |
| Held-back · full | 3 of 3 | 0 | 697 | 1,573 | 63,849 |
| Held-back · compact plus retained approvals | 3 of 3 | 0 | 702 | 725 | 30,928 |

The full-history arm found the omitted approval on one development task but incorrectly used a proposal on the other. On held-back tasks, adding pre-turn approvals yielded two paired gains and no losses; it left the no-approval case correct. The held-back compact input cost rose from 690 to 702 prompt tokens. The single seeded run does not establish a latency improvement.

**Verdict: inconclusive beyond this synthetic screen.** Retry with independently sampled tasks, pre-turn real history, actual compact Recall, and blind scoring of changes; measure the reliability and cost of identifying approvals without fixture labels.

Reproduce with `npx tsx eval/runner/history-omissions.ts`; interrupted runs can resume with `--resume` at the recorded baseline revision. `npx vitest run test/eval-history-omissions.test.ts` checks pre-turn, project and decision-type eligibility.
