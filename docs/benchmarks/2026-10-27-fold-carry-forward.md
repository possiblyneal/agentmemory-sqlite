# 2026-10-27 — Session Summary decision carry-forward (#335)

**Commit:** the commit that adds `carryDecisions` to `mem::summarize`
**Bench:** `eval:fold-drift` (aggregates only) and an attempted `eval:replay --llm --decision-key` before/after pair
**Hardware:** Operator workstation, Linux, Node 22+; LLM through the shared inference broker, which returned 429s and 300 s timeouts while three runs shared it

## Result

The gate failed for want of a measurement: neither decision-recall arm finished, so there is no before or after recall number, pooled or `typical`.

## Fold drift (`--longest 3 --batch 20`, after arm)

| Session | Observations | Folds | Fallbacks | Result |
|---|---|---|---|---|
| A | 1,316 | 64 | 1 | measured |
| B | 1,556 | — | — | failed: full pass hit the 300 s LLM timeout |
| C | 1,271 | — | — | failed: full pass hit the 300 s LLM timeout |

Session A: 207 decisions after the fold sequence. Decisions dropped by folds and by the fallback: 0 by word-set Jaccard >= 0.5. By exact text the run counts 8 (folds) and 4 (fallback): each is a carried decision that a restating decision replaced in place, so a decision with the same claim in new words is held. The tool reads both as drops. The pre-change figure on these Sessions was 426 dropped over 83 folds (#312). Two of the three Sessions did not complete, so "0 lost on the three longest" is not established.

## Decision-key recall

- The key was rebuilt once over 14 `agentmemory-sqlite` directories and 13 `glydr` directories (53 Sessions loaded, 316 decisions, 721 items), so `typical` is non-empty.
- Both arms (`--cap 40 --min-turns 2 --llm --decision-key`) were stopped after about 2.5 hours with 3 of 53 Sessions ingested. The Sessions run past 1,000 Observations each, and under `--llm` every Observation is compressed through the broker (single batches took over 10 minutes under contention).
- `eval:replay --llm` awaits one `/summarize` per Session, with no prior Summary, so it never folds. A fold or carry-forward change cannot move its decision recall except through LLM run-to-run variance. Measuring this change needs a replay that summarizes a Session repeatedly, as the Stop hook does.

## Notes

- No `--llm` baseline for decision recall was produced here; the 2026-10-27 decision-key scorecard remains the only baseline.
- Private: the key, verdicts and transcripts stay under `tmp/` and are not committed.
