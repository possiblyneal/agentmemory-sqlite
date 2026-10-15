# 2026-10-15 — replay eval, Injection Gate off vs on

**Commit:** `1cb7953`
**Bench:** replay of the Operator's own Claude Code transcripts (`npm run eval:replay`; private data, aggregates only), probed twice from one set of LLM-compressed checkpoints
**N:** 40 probed Sessions in 7 repositories (11, 8, 7, 5, 4, 3, 2), 337 probed prompts, 58 answer-key items (55 files, 3 repeated corrections, 0 revisited decisions)
**K:** 5 for the `smart-search` baseline; a prompt-context Injection is scored whole
**Hardware:** linux 6.12, 8 cores, node 22.23
**Embeddings:** on-device (local MiniLM); `RERANK_ENABLED` off in both arms
**Injection Gate:** off arm `AGENTMEMORY_PROMPT_RERANK=off`; on arm `AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank`, defaults otherwise (min score 0.03, timeout capped at 1000 ms)
**LLM:** checkpoints built with OpenAI-compatible `general` → `Occult-Nail-1.0-35B-A3B-UD-Q4_K_XL` via the inference-runtime-broker (`10.10.10.13:4010`), `AGENTMEMORY_AUTO_COMPRESS=true`, `AGENTMEMORY_LLM_TIMEOUT_MS=300000`, `AGENTMEMORY_LLM_MAX_CONCURRENCY=1`; the probe passes make no LLM calls

## Headline

The gate helps Right content and leaves Right moment unchanged. It also costs a little search Recall and some latency. With the gate on, injected items fell 29% (542 → 384) and the used share rose from 12.4% to 17.7%, while Injection hits stayed at 44 / 58. Search alone lost 3 hits (13 → 10), because the gate also filters `smart-search` Observation hits, so either path fell from 46 to 45 of 58. The prompt-context p99 rose from 141 ms to 682 ms and the session-start p99 from 46 ms to 643 ms, still under the 1.5 s hook timeout with no probe over it.

## Per Goal line

| Goal line | Measure | Gate off | Gate on |
|---|---|---|---|
| Right content | injected items used by the Session | 67 / 542 (12.4%) | 68 / 384 (17.7%) |
| Right content | Injection chars per used item | 4,411 | 3,467 |
| Right content | Injection chars, total | 295.5k | 235.8k |
| Right moment | key items delivered in time, Injection | 44 / 58 (75.9%) | 44 / 58 (75.9%) |
| Right moment | key items delivered in time, search alone | 13 / 58 (22.4%) | 10 / 58 (17.2%) |
| Right moment | key items delivered in time, either | 46 / 58 (79.3%) | 45 / 58 (77.6%) |
| Right moment | by rule, either: file / correction / decision | 44 / 55, 2 / 3, — / 0 | 43 / 55, 2 / 3, — / 0 |
| Right moment | terse prompts, Injection / search / either | 20 / 29, 12 / 29, 22 / 29 | 22 / 29, 9 / 29, 22 / 29 |
| Right scope | injected items from another project | 0 / 542 | 0 / 384 |
| Durable beats recent | repeated corrections injected before the repeat | 2 / 3 | 2 / 3 |
| Least record | store bytes per distinct used item | 1.38 MB (77.5 MB store, 56 distinct used items) | same |
| Never on the critical path | session-start p50 / p99 | 31 ms / 46 ms | 30 ms / 643 ms |
| Never on the critical path | prompt-context p50 / p99 | 25 ms / 141 ms | 51 ms / 682 ms |
| Never on the critical path | smart-search p50 / p99 | 81 ms / 5,778 ms | 218 ms / 6,259 ms |
| Never on the critical path | hook probes over 1.5 s | 0 of 377 | 0 of 377 |
| Operator attention | store growth per replayed week | 18.3 MB (4.09 weeks replayed) | same |

## Methodology

- **Scope.** All 107 `~/.claude/projects` directories, frozen under `tmp/frozen-projects`, `--cap 1000 --min-turns 2 --keyed-only`, on the default dev split. `--keyed-only` probes only Sessions that hold an answer-key item. Ingest still replays every earlier Session, so 55 Sessions were replayed and 40 were probed. This replaces the three-repository, cap-40 subset in #205: that subset held too few key items to separate the arms.
- **One compression for both arms.** A save pass (`--llm --save-checkpoints`) replayed the 55 Sessions through the hook payloads with LLM Compression on. Before each probed Session it wrote a SQLite checkpoint of the store. It ran for 47.9 h and made 12,983 compress calls (13 failed and fell back to synthetic) and 55 summarize calls (all succeeded). Each arm then ran `--from-checkpoints`, which restores each checkpoint into a fresh sandbox and probes it with the LLM off. Both arms read the same bytes, so the only difference between them is the gate's environment.
- Probe passes took 6.5 min (off) and 8.3 min (on), both on `--instance 9`.
- Everything else is as in `eval/README.md` (Replay).

## Reproduce

```sh
git checkout 1cb7953
npm ci && npm run build
P=<every directory, comma-separated>
npm run eval:replay -- --projects=$P --cap 1000 --min-turns 2 --keyed-only --llm \
  --save-checkpoints tmp/eval-replay/ckpt
AGENTMEMORY_PROMPT_RERANK=off npm run eval:replay -- --projects=$P --cap 1000 --min-turns 2 \
  --keyed-only --from-checkpoints tmp/eval-replay/ckpt/checkpoints
AGENTMEMORY_PROMPT_RERANK_URL=<reranker> npm run eval:replay -- --projects=$P --cap 1000 \
  --min-turns 2 --keyed-only --from-checkpoints tmp/eval-replay/ckpt/checkpoints
```

Needs your own `~/.claude/projects` and an OpenAI-compatible LLM for the save pass; numbers will differ.

## Notes

- **Verdict: helps.** The gate drops 158 injected items, and used items still rise from 67 to 68. That is the Right content gain the gate was built for, and the Injection hit rate does not move. On terse prompts, which the headline leaves out, the Injection gains 2 items (20 → 22 of 29).
- **The search loss is the gate's cost.** `smart-search` Observation hits pass through the same gate, and 3 file items that search alone delivered with the gate off fell below the 0.03 floor. Injection covers 2 of them, so either path loses only 1. Terse prompts lose 3 more search hits (12 → 9), but Injection picks up 2 of those items, so either stays at 22 of 29.
- **Every search over 1.5 s is a cold start, not the gate.** In both arms, all 40 are the first search of a Session, the first query after a checkpoint restore. Without those, search p50 / p99 is 77 / 249 ms off and 200 / 613 ms on (n = 297). The two hook paths had no such outlier.
- **The gate's latency is the reranker round trip.** At its p99 that round trip uses about 45% of the hook budget. A slower reranker host would reach the gate's 1000 ms timeout and fail open to the BM25 selection. That keeps the Session unblocked but forfeits the content gain.
- **The key is still mostly files.** 55 of 58 items are files. The 3 repeated corrections score the same in both arms, and no revisited decisions appear, so this run does not test the gate on decisions.
