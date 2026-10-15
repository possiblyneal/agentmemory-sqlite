# 2026-10-15 — replay eval, LLM Compression vs synthetic

**Commit:** `7c0415f`
**Bench:** replay of the Operator's own Claude Code transcripts (`npm run eval:replay`; private data, aggregates only), three store builds of the same Sessions, each probed with the Injection Gate off and on
**N:** 40 probed Sessions in 7 repositories, 337 probed prompts, 58 headline answer-key items (55 files, 3 repeated corrections, 0 revisited decisions) plus 29 terse-prompt file needs scored apart; identical in every arm
**K:** 5 for the `smart-search` baseline; a prompt-context Injection is scored whole
**Hardware:** linux 6.12, 8 cores, node 22.23
**Embeddings:** on-device (local MiniLM); `RERANK_ENABLED` off in every arm
**Injection Gate:** off arm `AGENTMEMORY_PROMPT_RERANK=off`; on arm `AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank`, defaults otherwise (min score 0.03, timeout capped at 1000 ms)
**LLM:** OpenAI-compatible `general` → `Occult-Nail-1.0-35B-A3B-UD-Q4_K_XL` via the inference-runtime-broker, `AGENTMEMORY_LLM_MAX_CONCURRENCY=1`, `AGENTMEMORY_LLM_TIMEOUT_MS=300000`, for the save passes that use it; the probe passes make no LLM calls

## Headline

LLM Compression helps, and on a local broker the cost is worth paying. Against the same hook-path store with synthetic compression, it delivers 7 more of 58 key items in time by either path (39 → 46; sign test p = 0.09, so directional). The significant gain is search: alone it gains 9 (4 → 13; p = 0.02), and on terse prompts it goes from 1 to 12 of 29 (p = 0.001). The LLM store is also 12% smaller (77.5 vs 88.5 MB). The gain comes almost entirely from file attribution: 76% of LLM-compressed Observations name a file, against 8% of synthetic ones. The price is 45.0 h of waiting on compression (41 h more wall-clock than the synthetic build) and 12,983 compress calls for 4.09 weeks of replayed work. All of it runs off the critical path, and no hook probe in any arm passed 1.5 s.

## Builds

All three replay the same 55 `--keyed-only` Sessions and save a checkpoint before each of the 40 probed ones. Every probe pass then runs `--from-checkpoints` on the same commit with the LLM off, so the arms differ only in how the store was built.

| Build | Ingest | Compression | Session Summaries |
|---|---|---|---|
| **LLM** | hook payloads to `/observe` (`--llm`) | LLM | LLM |
| **Synthetic** | hook payloads to `/observe` (`--llm`, `AGENTMEMORY_AUTO_COMPRESS=false`) | synthetic | LLM |
| **Import** | `import-jsonl` (no `--llm`), the ticket's no-LLM arm | synthetic | none |

The LLM build reuses the checkpoints of the [2026-10-15 gate scorecard](2026-10-15-replay-gate.md), probed again on `7c0415f`. On that commit the gate no longer filters `smart-search` (#221), so the gate-on search figure is now 13 / 58, where that scorecard had 10. Every gate-off Right content and Right moment figure matches that scorecard exactly.

## Per Goal line, gate off

| Goal line | Measure | LLM | Synthetic | Import |
|---|---|---|---|---|
| Right content | injected items used by the Session | 67 / 542 (12.4%) | 71 / 587 (12.1%) | 57 / 1,153 (4.9%) |
| Right content | Injection chars per used item | 4,411 | 4,717 | 8,133 |
| Right content | Injection chars, total | 295.5k | 334.9k | 463.6k |
| Right moment | key items delivered in time, Injection | 44 / 58 | 37 / 58 | 3 / 58 |
| Right moment | key items delivered in time, search alone | 13 / 58 | 4 / 58 | 4 / 58 |
| Right moment | key items delivered in time, either | 46 / 58 | 39 / 58 | 6 / 58 |
| Right moment | by rule, either: file / correction | 44 / 55, 2 / 3 | 37 / 55, 2 / 3 | 5 / 55, 1 / 3 |
| Right moment | terse prompts, Injection / search / either | 20 / 12 / 22 of 29 | 18 / 1 / 18 of 29 | 0 / 0 / 0 of 29 |
| Right scope | injected items from another project | 0 | 0 | 0 |
| Durable beats recent | repeated corrections injected before the repeat | 2 / 3 | 1 / 3 | 0 / 3 |
| Least record | store bytes per distinct used item | 1.38 MB (77.5 MB, 56 items) | 1.53 MB (88.5 MB, 58 items) | 2.61 MB (143.6 MB, 55 items) |
| Never on the critical path | session-start p50 / p99 | 9 / 268 ms | 8 / 118 ms | 36 / 132 ms |
| Never on the critical path | prompt-context p50 / p99 | 25 / 178 ms | 18 / 183 ms | 22 / 194 ms |
| Never on the critical path | smart-search p50 / p99 | 87 / 250 ms | 59 / 172 ms | 88 / 257 ms |
| Never on the critical path | hook probes over 1.5 s | 0 of 377 | 0 of 377 | 0 of 377 |
| Operator attention | store growth per replayed week | 18.3 MB | 21.1 MB | 34.2 MB |

## Per Goal line, gate on

Store size and growth are unchanged from the gate-off table.

| Goal line | Measure | LLM | Synthetic | Import |
|---|---|---|---|---|
| Right content | injected items used by the Session | 68 / 384 (17.7%) | 66 / 416 (15.9%) | 49 / 892 (5.5%) |
| Right content | Injection chars per used item | 3,467 | 3,816 | 7,085 |
| Right moment | key items in time, Injection / search / either | 44 / 13 / 46 of 58 | 37 / 4 / 39 of 58 | 3 / 4 / 5 of 58 |
| Right moment | terse prompts, Injection / search / either | 22 / 12 / 22 of 29 | 18 / 1 / 18 of 29 | 0 / 0 / 0 of 29 |
| Right scope | injected items from another project | 0 | 0 | 0 |
| Durable beats recent | repeated corrections injected before the repeat | 2 / 3 | 1 / 3 | 0 / 3 |
| Least record | distinct used items | 56 | 53 | 48 |
| Never on the critical path | session-start p50 / p99 | 7 / 132 ms | 7 / 152 ms | 36 / 108 ms |
| Never on the critical path | prompt-context p50 / p99 | 22 / 529 ms | 28 / 492 ms | 286 / 664 ms |
| Never on the critical path | smart-search p50 / p99 | 60 / 184 ms | 59 / 292 ms | 86 / 336 ms |
| Never on the critical path | hook probes over 1.5 s | 0 of 377 | 0 of 377 | 0 of 377 |

## Cost of each build

| Build | Wall-clock | Compress calls | Summarize calls | Mean summarize latency |
|---|---|---|---|---|
| LLM | 47.9 h (45.0 h waiting on compression) | 12,983 (13 fell back to synthetic) | 55 (55 succeeded) | 181 s |
| Synthetic | 6.9 h | 0 | 57 (56 succeeded; 1 of 55 Sessions has no Summary) | 460 s |
| Import | 48.7 min | 0 | 0 | — |

The LLM build spent 45.0 h waiting on 12,983 compress calls, about 12.5 s per call at concurrency 1. Its wall-clock is 41.0 h longer than the synthetic build's: outside compression it took 2.9 h, against the synthetic build's 6.9 h. Mean summarize latency, queue wait included, is about 2.5× lower with LLM Compression, and its narratives are about 3× shorter (470 vs 1,390 chars per Observation in the final checkpoint).

## Methodology

- **Scope.** As in the [2026-10-15 gate scorecard](2026-10-15-replay-gate.md): all 107 `~/.claude/projects` directories, frozen under `tmp/frozen-projects`, `--cap 1000 --min-turns 2 --keyed-only`, default dev split. The scored Sessions and answer key are identical in all six arms.
- **Paired test.** Each arm scores the same 58 + 29 key items, so LLM and Synthetic are compared item by item with a two-sided sign test on the items only one of them delivered. Gate off: either path 10 vs 3 (p = 0.09), search 11 vs 2 (p = 0.02), terse search 11 vs 0 (p = 0.001). Gate on gives the same picture (either 9 vs 2, p = 0.07).
- **Store size** is the last checkpoint (before the 40th probed Session), the same for both gate arms of a build.
- **Load.** The probe passes ran on `--instance 6` while another worktree's replay sandboxes ran on the same host, so latency is comparable within this scorecard only. The LLM build's latencies differ from the gate scorecard's for the same checkpoints for this reason.
- Everything else is as in `eval/README.md` (Replay).

## Reproduce

```sh
git checkout 7c0415f
npm ci && npm run build
COMMON=(--projects=<every directory, comma-separated> --cap 1000 --min-turns 2 --keyed-only)
# LLM build: the save pass of the 2026-10-15 gate scorecard (tmp/eval-replay/ckpt)
# Synthetic build: hook path, LLM for Summaries only (needs OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_KEY)
AGENTMEMORY_AUTO_COMPRESS=false AGENTMEMORY_LLM_MAX_CONCURRENCY=1 AGENTMEMORY_LLM_TIMEOUT_MS=300000 \
  AGENTMEMORY_PROMPT_RERANK=off npm run eval:replay -- "${COMMON[@]}" --llm --save-checkpoints --out tmp/eval-replay/t217-hooks
# Import build: no LLM
AGENTMEMORY_PROMPT_RERANK=off npm run eval:replay -- "${COMMON[@]}" --save-checkpoints --out tmp/eval-replay/t217-import
# each build, gate off and on
AGENTMEMORY_PROMPT_RERANK=off npm run eval:replay -- "${COMMON[@]}" \
  --from-checkpoints tmp/eval-replay/<build>/checkpoints --out tmp/eval-replay/<build>-off
AGENTMEMORY_PROMPT_RERANK_URL=<reranker> npm run eval:replay -- "${COMMON[@]}" \
  --from-checkpoints tmp/eval-replay/<build>/checkpoints --out tmp/eval-replay/<build>-on
# the LLM build's checkpoints are tmp/eval-replay/ckpt/checkpoints
```

Needs your own `~/.claude/projects` and an OpenAI-compatible LLM; numbers will differ.

## Notes

- **Verdict: helps, and justifies its cost on a local broker.** It helps significantly on search and directionally by either path. Against the synthetic hook-path store, LLM Compression delivers 7 more key items by either path (p = 0.09), 9 more by search alone and 11 more terse-prompt items by search. It also holds 1 more repeated correction and keeps a 12% smaller store, while the used share stays level (12.4% vs 12.1%). Its cost is broker time, not money and not latency. It runs off the critical path, and 45.0 h of compression over 4.09 replayed weeks is about 11 h a week at concurrency 1. These were 55 of the 242 Sessions in that span, so live load is higher, but it still fits a dedicated broker. On a metered API, 12,983 calls per 55 Sessions would need its own price check.
- **The gain is file attribution.** Synthetic compression names a file in 8% of Observations, LLM Compression in 76%. 55 of 58 headline items are files, so this measure leans toward that gain. Better synthetic file extraction could close part of the search gap without the LLM.
- **The ticket's no-LLM arm measures `import-jsonl`, not compression.** In the final checkpoint (54 Sessions) the importer has filed 35,421 Observations, 2.4× the hook path's 15,042, 55% of them typed `other`, and only 4% name a file. It also writes no Summaries. Its 6 / 58 is a fact about that ingest path, which hooks never take and only backfilled history (`agentmemory import-jsonl`) goes through, so the Synthetic build is the fair counterfactual.
- **The gate's effect does not depend on the build.** In LLM, Synthetic and Import alike, the gate cuts injected items by 23–29% and leaves key-item Injection hits unchanged. Terse-prompt Injection hits rise from 20 to 22 of 29 for LLM only.
- **The key is still mostly files**, and no revisited decisions appear, so this run does not test whether LLM Compression helps decisions.
