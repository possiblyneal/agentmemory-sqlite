# Clarify unresolved consequential choices (#571)

Baseline `fe07c2d8`. Both arms receive the same scoped production Semantic Fact Recall hits on six synthetic choices, at a limit of two, and first remove claims covered by an explicit fixture amendment. The silent arm chooses the first remaining option. The treatment asks only when two distinct options remain and the task is marked consequential, then receives the simulated Operator's answer. The answer key is unavailable to the policy until it asks. Score exact actions mechanically; no model, real Operator interruption, or repository holdout was used.

Freeze the criterion at strictly lower total Operator time, no increase in incorrect choices, and no questions when scoped evidence already settles the answer or the case is low stakes. A consequential error costs 12 virtual time units, a low-stakes error costs two, and every question costs two.

| Measure | Silent guess | Targeted clarification |
|---|---:|---:|
| Incorrect choices | 2 of 6 | 1 of 6 |
| Rework (virtual units) | 14 | 2 |
| Questions | 0 | 2 |
| Interruption time (virtual units) | 0 | 4 |
| Total Operator time (virtual units) | 14 | 6 |

One paired improvement, no new wrong choices. Both arms resolved the explicit amendment, the single scoped claim, and consistent evidence. Neither asked on the low-stakes case, leaving its wrong guess unchanged. One of the two questions was unnecessary in hindsight because the silent guess was correct, though the evidence alone did not settle it. Holding rework fixed, the gain disappears at six units per question: 12 units of avoided rework divided by two questions.

**Verdict: inconclusive for real Operator time.** The synthetic policy passed with stipulated stakes, costs and perfectly informative answers. Retry with blind replay of independently adjudicated choices, measured interruption and rework time, and missing or ambiguous Operator answers.

Reproduce with `npx tsx eval/runner/clarification.ts`; verify with `npx vitest run test/eval-clarification.test.ts`.
