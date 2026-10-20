# 2026-10-20 — Skip the Injection Gate on a BM25 top-1 margin (rejected)

**Commit:** `090fdad` plus an uncommitted prototype (reverted; not shipped)
**Bench:** `eval:coding-life` (agentmemory adapter, gate on, dev split) and a 10-Session `eval:replay` of the Operator's homelab and glydr transcripts (gate on, `--cap 12 --max-prompts 15`)
**N:** coding-life prompt-submit 9 (6 reach the gate; 3 have 2 candidates); replay 42 gate entries, 37 with 2+ candidates
**Hardware:** linux x86_64, shared host at load average 25-40, Node 22+
**Embeddings:** on-device
**LLM:** none
**Reranker:** homelab `qwen3-rr-0.6b-q8` at `AGENTMEMORY_PROMPT_RERANK_URL`, `_MIN` 0.03, timeout 1000 ms, pool 10

## Headline

No margin earns its place, so nothing shipped. The prototype skipped the gate when the top candidate's BM25 score was at least M times the runner-up's. On coding-life the gate changes nothing, so every margin scores the same as gate-always and gate-off; on the Operator's transcripts the margins are so small that a margin that skips often skips where BM25 cannot tell the top two apart, and a confident one skips about 1 prompt in 20.

## Coding-life prompt-submit (9 questions)

| Arm | Skip rate (of gated) | recall | precision | no-answer | hit | gate time on a gated prompt |
|---|---|---|---|---|---|---|
| gate off | n/a | 0.861 | 1.000 | 1.000 | 9/9 | 0 |
| gate always (M = inf) | 0/6 | 0.861 | 1.000 | 1.000 | 9/9 | 56-250 ms |
| M = 1.7 | 0/6 | 0.861 | 1.000 | 1.000 | 9/9 | 56-250 ms |
| M = 1.58 | 1/6 | 0.861 | 1.000 | 1.000 | 9/9 | 56-260 ms |
| M = 1.3 | 2/6 | 0.861 | 1.000 | 1.000 | 9/9 | 56-250 ms |
| M = 1.0 | 3/6 | 0.861 | 1.000 | 1.000 | 9/9 | 56-370 ms |

Margins of the three prompts with 2 candidates: 1.03, 1.56, 1.61. Prompts with 1 candidate have no margin and keep going to the gate, since the gate also drops a lone candidate scoring under `_MIN`. The 0.861 recall is the vector adapter's, identical with the gate off; it sits under the BM25 adapter's floor of 0.907 before and after, so no arm crosses it. The corpus is too small to show a case where the gate and BM25 disagree, so it cannot show whether a skip drops a right answer. The suite's other benches (search, PrecisionMemBench, LongMemEval) never call the gate and were not rerun.

## Margin distribution on real prompts (replay, 37 prompts with 2+ candidates)

| Margin M | Prompts skipped | Gate time saved |
|---|---|---|
| 1.1 | 43% | 7.0 s of 15.7 s |
| 1.25 | 19% | 2.9 s |
| 1.5 | 5% | 0.5 s |
| 2.0 | 0% | 0 |

Median margin 1.08; the largest was 1.77. Gate time per gated prompt: median 400 ms, max 1003 ms (one timeout, which falls back to BM25). Candidates are already within 0.5x of the best by the relative floor, so the top two are close by construction, and BM25 scores that close are the ones a reranker is there to order. The replay run had no key items (`keyItems` 0, 4 of 194 injected items used), so it gives no quality signal for a skip.

## Verdict

- A margin of 1.5 or more is the only one that could claim confidence, and it saves a tenth of a second on one prompt in 20.
- A margin of 1.1-1.25 saves 2.9-7.0 s over 37 prompts, but no available eval can show that those skips keep the right Observation first, and the rejected floors (#254) show that margin-style tests drop right answers.
- The gate is already off the critical path on failure (timeout falls back to BM25, 60 s cooldown) and capped at pool 10, so the cost left is a few hundred ms on prompts the hook has 1.5 s for.
- A skip also needs a counter in `/diagnostics` `injection-gate`; none was added.

Reopen if a reranker with a slower call or a corpus with disagreeing gate and BM25 orders (keyed replay under `--llm`) is on hand to measure the quality side. The vector-leg half of #288 was not tried.

## Reproduce

```sh
npm run build
export AGENTMEMORY_PROMPT_RERANK=on AGENTMEMORY_PROMPT_RERANK_URL=<reranker>
npm run eval:coding-life -- --instance 39 --adapters agentmemory
npm run eval:replay -- --projects=<dirs> --cap 12 --max-prompts 15 --instance 39
```
The prototype logged `candidates[0].score / candidates[1].score` and the gate wall time per prompt in `mem::prompt-context`; it is not kept.
