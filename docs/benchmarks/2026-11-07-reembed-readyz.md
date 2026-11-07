# 2026-11-07 — Daemon responsiveness during a full boot re-embed

**Commit:** main `6b0604c1` (worker-thread local embedder, #341)
**Bench:** a copy of the live store booted as instance 2 with no recorded vector space, so boot
dropped all 91,268 vectors and the fill pass re-embedded them; `GET /agentmemory/readyz` polled
once a second from first answer to the end of the fill
**N:** 10,371 polls over 173 min
**LLM:** none
**Embeddings:** local `Xenova/all-MiniLM-L6-v2`, mean pooling, 384 dims, on the worker thread
**Hardware:** Intel i3-10100T (8 threads), 31 GB RAM; load average 23–46 from other sessions during the run

## Headline

The event loop no longer waits on the embedder. Over a 173-minute re-embed, `readyz` answered at
p99 32 ms. Every poll over the hooks' 1,500 ms Injection timeout came from one 9.3 s stall that
audit eviction caused (#356), not the embedder. Before the worker thread (ADR 0002), 85% of polls
went over 1,500 ms.

## Result

| | before worker thread (ADR 0002) | worker thread, full store |
|---|---|---|
| vectors re-embedded | full store | 91,268 (0 failed) |
| duration | ~85 min | 173 min |
| `readyz` polls over 1,500 ms | 85% | 9 of 10,371 (0.09%) |
| p50 / p95 / p99 | — | 2.2 / 12.6 / 32 ms |
| p99.9 / max | — | 750 ms / 9,298 ms |
| non-200 | — | 0 |

- The 9 slow polls are consecutive, from 18:57:33, about 6 min after boot. This is the first
  audit eviction sweep (5 min after boot): `Audit log evicted beyond cap {"removed":7436,"kept":50000}`.
  It lists and deletes about 57k rows synchronously (#356).
- The other slow polls: 750 ms and 345 ms at exactly ready + 1 h and + 2 h, beside the hourly
  `Injection records swept`; 533 ms at 20:44:31 with nothing logged.
- The run took twice as long as the old one. The host was shared with other sessions at load
  average 23–46, and throughput swung threefold by hour (21.6k, 50.0k, 19.7k vectors), so this run
  measures latency, not throughput.

## Methodology

- Store: a copy of `/home/neal/data/agentmemory.sqlite`; the live file was only read.
- Daemon: this commit's `dist/cli.mjs --instance 2` with `AGENTMEMORY_PROMPT_RERANK=off`, its own
  home and data directory. LLM work, compression, consolidation, graph extraction, backup,
  eviction, decay, snapshot and auto-forget were off; audit eviction and the hourly sweeps have no
  off switch.
- Poller: one `readyz` request a second, recording latency and status; progress read from the
  copy's vector count once a minute. The window runs from the first 200 to the minute the count
  reached 91,268; `index-fill-missing finished` logged `durationMs` 10,386,335.

## Reproduce

Session-folder scripts (`reembed/run.sh`, `scripts/poll.mjs`, `scripts/analyze.mjs`): copy the store, boot an
instance on it with no `embedding:vectorSpace` recorded, poll `readyz`, analyse `polls.ndjson`.
