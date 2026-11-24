# Fact validity across amendments (#564)

## Comparison

Baseline `25ca0c3b`: scoped production Semantic Fact Recall, limit one, with an exclusive record-time upper bound just after the requested day’s UTC midnight for historical questions. Treatment: read-only exact-topic selection over the same synthetic claim history, using supplied effective intervals `[from, until)` instead of the latest marker or record date. Both arms receive claims recorded by the knowledge cutoff; historical questions use the November 23 snapshot, so they ask what applied on a past date, not what the Agent knew on that date. Current questions use their own date as the cutoff. The scheduled amendment serves as a control once effective. No model, migration, live store or holdout was used.

Before scoring, require improvement on both historical and current questions, zero lost correct answers and zero foreign claims. Score exact answers and the distinction between missing dates, a gap, conflicting intervals and no scoped evidence.

## Results

| Metric | Record-time Recall | Validity view |
|---|---:|---:|
| Historical answers and statuses correct | 0 of 4 | 4 of 4 |
| Current answers and statuses correct | 2 of 4 | 4 of 4 |
| Foreign claims returned | 0 | 0 |

Six paired gains, no paired losses. The baseline missed the original rule and the effective-date boundary, selected a future amendment as current, and returned a claim in each of the missing-date, gap and overlap cases. The treatment reported those three uncertainties separately. Both returned the scheduled rule once it took effect and no answer for the foreign-only topic.

**Verdict: inconclusive outside the synthetic screen.** The treatment uses supplied topic and validity labels and has access to superseded rows from the same history that ordinary Recall filters out. This does not establish extractability, accuracy on real histories, or comparable daemon latency. Retry with independently dated real amendments and a common retrieval stage, including costs and errors for extracting validity intervals and resolving conflicts.

Reproduce with `npx tsx eval/runner/fact-validity.ts`; `npx vitest run test/eval-fact-validity.test.ts` checks the paired controls.
