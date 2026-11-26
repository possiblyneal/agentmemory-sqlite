# Withholding explicitly superseded Lessons (#534)

## Design

- **Baseline:** `62ea8c2d429775cba7f6d133127f5eef5158cb91`, the unchanged `mem::context` registrar.
- **Treatment:** A guarded, isolated build changes only Lesson selection in `mem::context`. A fixture-supplied contradiction pair is withheld only if a newer same-project rule is pinned. No similarity detector or stored mutation is involved.
- **Cohort:** Six synthetic task fixtures: two explicit reversals, an unchanged rule, a similar but noncontradictory rule, a foreign-project rule, and a Lesson newer than a contradictory rule. Both arms start with the same records and a 2,000-token budget. A deterministic consumer reads the target assignment in the visible Lesson block first, then falls back to the rule. A frozen expected assignment scores the resulting action. This is a stress proxy for following a stale Lesson, not measured Agent behavior.
- **Pre-measure rule:** Fewer stale choices, no lost correct choices, and no change to the control Injections or stored Lessons. No holdout or private records used.

## Paired results

| Metric | Baseline | Treatment |
|---|---:|---:|
| Stale choices | 2 | 0 |
| Correct choices | 4 | 6 |

Both explicit reversals improved in the proxy. No control Injection or stored Lesson changed. Correct choices on the controls were all preserved.

**Verdict:** The synthetic proxy passes, but the real effect is **inconclusive**. The experiment supplies the contradiction labels and makes the consumer prefer the stale Lesson when it is visible. It does not estimate false positives, misses, Agent behavior, or action rework. Retry only with independently labeled project-rule changes and a blinded paired action test that also includes similar-but-not-contradictory Lessons. Do not ship this treatment from the proxy alone.

## Reproduction

`npx tsx eval/runner/superseded-lessons.ts` prints the paired aggregate. `npx vitest run test/eval-superseded-lessons.test.ts` verifies the fixture. The isolated renderer is built under `tmp/superseded-lessons/`; no production source changes.
