# 2026-10-23 — Pinned rules at session start and pre-compact (#297)

**Commit:** `2591b079` (main) plus the uncommitted eval changes on `feat/eval-pinned-rules`; no `src/` change
**Bench:** `eval/data/pinned-rules` through `runner/coding-life.ts`, `--split all`; `eval:gate` and `eval:gate:rules`
**N:** session-start 3 (2 rule questions, 1 no-answer); pre-compact 3 (2 rule questions, 1 no-answer)
**K:** n/a, each Injection is scored whole
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** none (`agentmemory-bm25`) and on-device (`agentmemory`), identical results
**LLM:** none

## Headline

Measurement only, with no lever. Pinned `type: "rule"` Memories reach the Agent every time. Rule recall is **1.00 at session start and 1.00 at pre-compact**, and the gold rule leads the Injection in every case (first = 1.00). The `## Rules` block uses at most **6.2%** of the session-start budget (124 of 2000 estimated tokens) and **8.3%** of the pre-compact budget (124 of 1500). The cap is 40% (`RULEBOOK_BUDGET_SHARE`). Two runs gave identical per-question results, so the fixtures are gated as `eval:gate:rules`.

## Pinned rules

| Adapter | Path | Rule questions | Rule recall | First | Max share of budget |
|---|---|---|---|---|---|
| agentmemory-bm25 | session-start | 2 | 1.000 | 1.000 | 0.062 |
| agentmemory-bm25 | pre-compact | 2 | 1.000 | 1.000 | 0.083 |
| agentmemory | session-start | 2 | 1.000 | 1.000 | 0.062 |
| agentmemory | pre-compact | 2 | 1.000 | 1.000 | 0.083 |

| Question | Fixture | Path | Injection, in order | Rules share |
|---|---|---|---|---|
| r-001 | F3 rule buried (`tidepool`) | session-start | `tide-r01`, tide-008 … tide-003 (2 of 8 work Sessions cut) | 0.046 |
| c-001 | F3 rule buried (`tidepool`) | pre-compact | `tide-r01`, tide-008 … tide-005 (4 of 8 cut) | 0.061 |
| r-002 | F2 rule amended (`kelpie`) | session-start | `kelp-r02`, kelp-r01, kelp-006 … kelp-001 | 0.062 |
| c-002 | F2 rule amended (`kelpie`) | pre-compact | `kelp-r02`, kelp-r01, kelp-006 … kelp-002 | 0.083 |
| r-n01, c-n01 | project never worked on | both | nothing | — |

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory-bm25 | session-start | 3 | 1.000 | 0.423 | 1.000 | 3/3 | 3420 | 8 ms |
| agentmemory-bm25 | pre-compact | 3 | 1.000 | 0.448 | 1.000 | 3/3 | 2612 | 14 ms |
| agentmemory | session-start | 3 | 1.000 | 0.423 | 1.000 | 3/3 | 3420 | 10 ms |
| agentmemory | pre-compact | 3 | 1.000 | 0.448 | 1.000 | 3/3 | 2612 | 4 ms |

The rule is the only gold, so precision here counts the work Sessions the budget still fits, not missed rules.

## Stability and the gate

Run 1 (instance 44) and run 2 (instance 45) returned the same Session ids in the same order and the same rules share for all 12 rows. p95 was at most 22 ms on either path, against the 500 ms ceiling. The fixtures are gated as follows:

- **Where it runs:** `npm run eval:gate:rules`, after `eval:gate` on the CI Node 22 leg.
- **What it gates:** `baselines/pinned-rules.json` gates recall and no-answer clean on both paths at 1.00, with a 500 ms p95 ceiling on each.
- **Precision is not gated.** With the rule as the only gold, it moves whenever the budget fits more or fewer work Sessions.

The fixtures sit in a corpus of their own instead of being appended to `coding-agent-life-v2`. When they were appended, their 14 work Sessions shifted BM25 scores for existing questions:

- q-010 gained sess-002.
- p-002 gained sess-011, which took prompt-submit precision from 0.889 to 0.856.
- q-n01 went empty.
- q-005 reordered.

Session-start precision also fell from 1.000 to 0.654, because the rule questions joined that path's average. Holding them in the same baseline would have meant lowering floors on questions this change does not touch. With the corpora apart, `eval:gate` is unchanged (every metric +0.000).

## Methodology

As in `eval/README.md` (Pinned rules). Session start posts `/agentmemory/session/start`, which leaves the budget at the `TOKEN_BUDGET` default of 2000 because the sandbox leaves it unset. Pre-compact posts `/agentmemory/context` with `budget: 1500`, as `src/hooks/pre-compact.ts` does. The rules share is `estimateTokens` of the `## Rules` block (heading to the next blank line) over that budget. Rules are saved through `POST /agentmemory/remember` with `type: "rule"` and the Session's project.

## Reproduce

```sh
npm ci && npm run build
AGENTMEMORY_EVAL_HOLDOUT=scorecard-2026-10-23-pinned-rules npm run eval:coding-life -- --data eval/data/pinned-rules --adapters agentmemory-bm25,agentmemory --split all --instance 44
npm run eval:gate:rules
```

## Notes

- F2 is answered only by order. `kelp-r01` (exact pins) is still pinned directly below `kelp-r02` (caret ranges), which replaces it. The two texts overlap far less than `mem::remember`'s 0.7 Jaccard supersession threshold, so both stay `isLatest`. The heading ("newest first … still hold until the Operator changes them") tells the Agent that both still hold. Recall scores 1.00 because the gold leads, but the Agent still reads a rule that was replaced. This is a candidate for a supersession cell, not a recall miss.
- Pre-compact rule recall is 1.00, so no follow-up is drafted under #297's condition. At 1500 tokens the block takes 91–124 tokens. That leaves about 480 tokens of the 600-token share for Lessons before any rule would be skipped.
