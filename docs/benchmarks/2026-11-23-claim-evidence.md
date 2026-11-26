# Claim validity and source evidence (#558)

## Frozen comparison

Baseline `60a70c31`. The actual `mem::prompt-context` Summary path renders the same synthetic claims against a fixed project-scoped search hit with the Gate off. The treatment annotates each visible claim with its preassigned validity and one scoped source lookup; a missing source is named explicitly. These labels are supplied by the fixture, not inferred. The single-model action scorer sees neither arm nor visible context. Four pairs cover a reversal, unapproved evidence, a missing source, and a valid requirement. Require at least one avoided stale or unsupported action, zero newly unsafe actions and zero lost correct actions, with at most 64 added prompt tokens per pair. Count added lookups and measure in-memory lookup-plus-formatting time separately from model time.

Local `general-eval-b` is used serially, at temperature 0 and seed 42, with a 2,048-output-token cap and a 60-second deadline, alternating paired arm order. This is a synthetic action screen, not the repository holdout or a live coding replay.

## Results

| Metric | Summary alone | Summary with validity and source |
|---|---:|---:|
| Correct actions | 2 of 4 | 4 of 4 |
| Stale or unsupported actions | 2 of 4 | 0 of 4 |
| Total prompt tokens | 1,322 | 1,394 |
| Scoped source lookups | 0 | 5 |
| Total model time | 125,812 ms | 104,310 ms |

Both gains were correct deferrals, one with uncertain evidence and one with an unavailable source. Both controls remained correct. The maximum added prompt cost was 31 tokens; all five in-memory lookups and formatting took about 0.230 ms in total. This does not measure database or network lookup latency. The model-call times are descriptive and do not isolate the cost of the annotations.

**Verdict: inconclusive for real Recall.** The prototype met the frozen acceptance rule on this synthetic screen with oracle validity labels. It does not establish that a system can attach accurate status and source automatically, that the result survives real Recall and latency budgets, or whether the gain came from status, source text, or both. Retry with independently labeled, task-relevant claims, measured source availability and lookup cost, and a status-only arm to isolate the benefit of source text.

Reproduce from the baseline with `npx tsx eval/runner/claim-evidence.ts`; `--resume` reuses completed rows if the baseline and runner are unchanged. `npx vitest run test/eval-claim-evidence.test.ts` checks missing-source rendering and the blind action score without a model. Raw trials stay local.
