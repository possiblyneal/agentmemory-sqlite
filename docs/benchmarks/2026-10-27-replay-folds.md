# 2026-10-27 — replay folds Session Summaries (partial, throughput-blocked)

**Commit:** the commit that adds `eval:replay --llm-summary` (#338)
**Bench:** `eval:replay --llm-summary --decision-key --cap 40 --min-turns 2 --instance 37` over the Operator's own transcripts (aggregates only)
**N:** 49 Sessions selected from 2 projects (24 directories); the run was stopped after 1 was ingested and a 2nd was mid-summarize
**LLM:** the daemon's OpenAI-compatible provider, `AGENTMEMORY_AUTO_COMPRESS=false` (Compression synthetic, Summaries by LLM)

## Headline

The run did not finish, so there is no decision recall to report: `summary.json` is written only at the end. This is not the before-arm for #335 yet. Throughput is the blocker.

## What ran

| Measure | Value |
|---|---|
| Wall time before stop | 1,766 s (~29 min) |
| Sessions ingested | 1 of 49 (a 2nd was mid-summarize) |
| Summarize outcomes | 8 total: 3 folded, 2 single, 1 chunked, 1 current-reused, 1 in flight |
| Observations stored | 146 |
| Tokenizer 429s | 3 (summarize falls back to estimating chunks) |
| Decision recall | not measured |

Session 1 (2 turns, 2 stops) took 244 s. Later Sessions have hundreds to over 1,000 Observations and many Stops each, and every Stop that sees new Observations is a fold (or a chunked full re-read when the fold prompt does not fit one chunk) over a store whose broker is returning 429s. At roughly 15 min per early Session the full set projects to well over the ~4 h limit, so it was stopped.

## Methodology

- A Stop is where the live hook fires: the main Agent finished a turn and the next prompt, not an interrupt, opens another. Each Stop awaits `/summarize` after only the Observations ingested before it; `mem::summarize` picks fold, re-read or reuse as live.
- No throttle was added. Live Stops are held until the Session idles, which a replay has no clock for; a Stop with nothing new is "current, reused" and costs no LLM call.
- Projects: the main `agentmemory-sqlite` directory, 13 of its orca workspaces and 9 glydr directories that hold key Sessions, plus the glydr main directory.

## Notes

- Compared with `--llm`, which sent every Observation through Compression and ingested 3 of 53 Sessions in 2.5 h, this mode kept Compression synthetic but still ingested slowly: summarize at every Stop is the cost, not Compression.
- To finish, either run when the broker is not shared, lower `AGENTMEMORY_LLM_MAX_CONCURRENCY` pressure, or fold less often (a throttle by Observation count would be a new design, not mirrored from the live daemon).
