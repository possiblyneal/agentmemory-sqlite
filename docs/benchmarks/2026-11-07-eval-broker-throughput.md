# 2026-11-07 — Broker throughput for eval summarize calls (#362, spec #359 lever 4)

**Commit:** `59d81453` (no repo code changed; the script lived in `tmp/broker-throughput/`)
**Bench:** 8 fixed summarize chunk prompts, replayed greedily against the broker
**N:** 8 chunks per run, 2 runs per setting; each prompt 13.3k to 16.9k tokens, replies 316 to 4,892 tokens
**LLM:** local broker `Occult-Nail-1.0-35B-A3B-UD-Q4_K_XL`, `general-eval-b` boot args (`--kv-unified`, ctx 204800, caches off), `--parallel` varied
**Hardware:** AI machine `10.10.10.13`, Strix Halo unified-memory APU
**Embeddings:** none

## Headline

More slots on the eval instance do not add summarize throughput, and they break replay
determinism. `--parallel` 2 finished the 8 chunks in the same wall time as `--parallel` 1
(272 and 277 s against 265 and 278 s), each call taking twice as long, and `--parallel` 4 was
slower (318 and 462 s). Only `--parallel` 1 repeats exactly: 8 of 8 replies byte-identical across
two runs, against 0 of 8 at 2 and at 4. Nothing was adopted and no broker change was made.
The CPU route could not be measured: the one CPU instance stayed busy with the live daemon's
`general` traffic for the whole window.

## Per setting

Greedy (`temperature` 0, `seed` 42, `reasoning_effort` none, `max_tokens` 8192), one worker per
slot pulling from a shared queue of the same 8 prompts, one warm-up call before the clock.

| Setting | Run | Wall | Output tok/s | Prompt tok/s | Mean / max call | Replies identical to the other run | Decision lists identical |
|---|---|---|---|---|---|---|---|
| `--parallel` 1 (`general-eval-b`) | 1 | 265 s | 15.5 | 440 | 33 / 50 s | 8 / 8 | 8 / 8 |
| | 2 | 278 s | 14.8 | 419 | 35 / 51 s | | |
| `--parallel` 2 | 1 | 272 s | 14.8 | 428 | 66 / 101 s | 0 / 8 | 0 / 8 |
| | 2 | 277 s | 14.7 | 421 | 68 / 111 s | | |
| `--parallel` 4 | 1 | 462 s | 17.5 | 252 | 178 / 462 s | 0 / 8 | 0 / 8 |
| | 2 | 318 s | 14.2 | 367 | 154 / 285 s | | |
| `--parallel` 1 + CPU route | | not measured here; see [2026-11-12 CPU route](./2026-11-12-eval-broker-cpu-route.md) | | | | | |

- The workload is prefill-bound: about 14k prompt tokens in for about 500 out, so the batch
  step that extra slots share is mostly one prompt's prefill, which does not batch. That fits
  prompt tok/s staying near 420 to 440 from one slot to two.
- `--parallel` 4 run 1's 17.5 output tok/s is not a speed-up: one reply looped to 4,892 tokens
  (217 decisions in the chunk-5 reply; a run's total was 8,095 tokens against about 4,100),
  which inflates the numerator while wall time rose by 74%. Its prompt tok/s fell to 252.
- Against the `--parallel` 1 run, no reply at 2 or 4 matched in either run, and decision
  counts moved (chunk 20: 5 at one slot, 15 and 5 at two, 11 and 4 at four; chunk 14: 4, 4 and
  8, 4 and 10). A batch that holds another request's tokens changes the numerics enough to
  change a greedy reply.
- Slot count × context stayed inside the shared pool: 4 × about 17k tokens in use against
  204,800 shared. No profile was adopted.

## CPU route

`cpu/<model>/general-eval-b` returned 429 `scheduler_busy` / `wait_timeout` after the broker's
240 s capacity wait. The CPU backend allows one instance and the live daemon's `general` overflow
held it, 4 of 4 slots in flight, from before the first run to the end of a 40 minute poll
(20:35 to 21:15). Freeing it meant stopping the container and discarding the live daemon's
in-flight calls, which this ticket does not authorize. Measured on 2026-11-12 with the CPU
instance freed: [2026-11-12 CPU route](./2026-11-12-eval-broker-cpu-route.md).

## Conditions

- The live daemon's `general` profile kept 8 to 10 requests in flight on the GPU instance and the
  CPU instance during every run (sampled before, every 15 s during, and after: 9 to 10, once 25).
  Every setting ran under that load, so absolute tok/s here is lower than an idle broker's and the
  comparison between settings is what holds. `--parallel` 1's repeat equality is not an effect of
  the load.
- Temporary profiles `general-eval-p2` and `general-eval-p4` (copies of `general-eval-b` with
  `--parallel` changed) were added through `POST /api/profiles` and deleted afterwards; the
  broker repo and the live `general` profile are unchanged.
- Re-measured call time for the AGENTMEMORY_LLM_TIMEOUT_MS note in `eval/README.md`: at one slot
  and chunk concurrency 1, a 14k-token chunk took 27 to 51 s (16 calls). Chunk concurrency 2
  on one slot queues the second call behind the first, which is why live reports are 90 to 135 s.

## Reproduce

Not committed (`tmp/` is private scratch). The method: build chunks with `buildSummaryPrompt` over
the Observations of one Session from a replay checkpoint (greedy-packed at 16,000 tokens, 8 chunks
evenly spaced from the Session's 23), POST each to `/v1/chat/completions` with the sampling above
through an undici dispatcher with no header or body timeout, one worker per slot taking the next
prompt from a shared queue, and write each finished (setting, run) to its own file so a restart
skips it.

## Notes

- A run that mixes in the GPU and CPU routes would also need a placement-independent equality
  check: the same chunk can land on either, and CPU and GPU numerics differ.
- `--parallel` 1 at chunk concurrency 1 was the fastest and the only deterministic setting; the
  slot count of `general-eval-b` stays 1.
