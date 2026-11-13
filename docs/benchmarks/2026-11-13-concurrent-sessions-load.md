# 2026-11-13 — concurrent Sessions load (#394, rohitg00/agentmemory#499)

**Commit:** `77fcdbba` (main)
**Bench:** synthetic hook traffic, no scored questions: N virtual Sessions against one throwaway daemon
**N:** 4, 16 and 32 concurrent Sessions, 40 to 60 s each, 1,200 / 12,000 / 16,000 / 20,000 seeded Observations
**K:** none (latency only)
**Hardware:** Linux 6.12, 12 cores, Node 22.23, shared with an unrelated eval and the broker: load average 28 to 37 for the whole test, so every absolute time is inflated
**Embeddings:** none (BM25 only; the live daemon also runs a local embedder)
**LLM:** none (synthetic Compression; no LLM or broker traffic)

## Headline

The daemon does not hang. `/livez` polled every 50 ms stayed under 500 ms at realistic load
(tool call every ~3 s per Session) and peaked at 2.2 s only at 32 Sessions each posting an
Observation every ~1 s. What reproduces is a **burst of Sessions opening together**: the first
`prompt-context` of each Session takes 1.0 to 3.6 s at 32 Sessions (24 to 32 of 32 past the hook's
1,500 ms `INJECT_TIMEOUT_MS`) and 0.1 to 0.3 s at 16. Later prompts of the same Sessions stay at
p50 100 to 350 ms. A Missed Injection under concurrency is queueing, not a stall.

## Latency by load

`over` counts calls past 1,500 ms. Think time is the mean gap between a Session's tool calls.

| Seed | Sessions | Think | livez max (ms) | prompt-context p50 / p95 (ms) | prompt-context over | observe p95 (ms) |
|---|---|---|---|---|---|---|
| 1,200 | 4 | 1 s | 309 | 453 / 671 | 0 / 20 | 146 |
| 1,200 | 16 | 1 s | 999 | 710 / 2,506 | 18 / 70 | 484 |
| 1,200 | 32 | 1 s | 2,208 | 1,900 / 5,177 | 76 / 119 | 1,513 |
| 1,200 | 16 | 3 s | 234 | 151 / 1,155 | 0 / 48 | 141 |
| 1,200 | 32 | 3 s | 467 | 190 / 1,603 | 10 / 96 | 147 |
| 20,000 | 16 | 3 s | 473 | 397 / 3,002 | 15 / 48 | 99 |
| 16,000 (8 Sessions at the 2,000 cap) | 16 | 3 s | 329 | 283 / 2,174 | 7 / 48 | 228 |

One Session alone: `prompt-context` 130 to 230 ms at 1,200 Observations and 211 ms (max 457)
serial on the 20,000 store restarted from its file.

## First prompt of a burst

Daemon restarted from the 20,000-Observation store, 32 Sessions started within 2 s, 3 s think.
"First" is a Session's first `prompt-context`.

| Build | Run | first within 1,500 ms | first p50 (ms) | later p95 (ms) |
|---|---|---|---|---|
| main | 1 | 0 / 32 | 2,250 | 660 |
| main | 2 | 8 / 32 | 1,826 | 1,761 |
| main | 3 | 2 / 32 | 2,006 | 968 |
| FIFO queue with shedding | 1 | 16 / 32 | 1,531 | 431 |
| FIFO queue with shedding | 2 | 5 / 32 | 1,586 | 519 |
| FIFO queue with shedding | 3 | 7 / 32 | 1,576 | 360 |

A profiled run of the same burst measured 0 / 32 over (p50 1,048, max 1,469).

## Methodology

- Driver (kept under `tmp/`, not in the repo): per Session `POST /session/start`,
  `/context`, then a loop of `/observe` (post_tool_use, 1.5 to 6.5 KB of source text) every
  `think` ms, and a `/prompt-context` plus prompt `/observe` every 8th step, then
  `/session/end`; a `/livez` poll every 50 ms beside it. Seed Observations are written the
  same way before timing starts. `--cpu-prof` on the daemon for the profiles.
- Port 9111 by `III_REST_PORT`: `--instance` above 50 is ignored by the CLI and falls back to
  3111, where the live daemon's own guard refused the start.
- Seed text is chunks of this repo's own source, so near-twin overlap (`capBehindNewer`) is
  likelier than in real Observations.

## Profile

- A busy daemon (16 Sessions, think 1 s) is event-loop bound: 43 s of 63 s busy. Largest
  shares: `capOlderNearTwins` 7.6 s, `storeSyntheticCompression` 6.4 s, response `writev` 4.2 s.
- A quiet burst (32 Sessions, 3 s think) is not: 56 s of 72 s idle. Searches total about
  37 ms CPU each, yet the first `prompt-context` of every Session waits about 32 times that.
  `searchCooperatively` and the Engine's KV yields (`setImmediate`, #371) interleave concurrent
  requests round-robin, so a burst finishes together at the sum of its work instead of one at
  a time.
- The daemon computes a `prompt-context` whose hook gave up at 1,500 ms; nothing cancels it.
- Boot is not a stall: `rebuildBm25FromContent` (17 s on 20,000 Observations) yields, and
  every other route answers 503 until it is done.

## Notes

- The live `missed-injections.jsonl` shows the same shape: bursts (413 prompt-submit and 340
  session-start timeouts on 2026-11-11) between days of 7 to 60.
- The prototype (a FIFO queue in `api::prompt-context` that sheds a request queued past
  `INJECT_TIMEOUT_MS`) raised first prompts served in time from 3 to 9 of 32 on average and
  cut later-prompt p95; three runs on a loaded host do not decide it.
