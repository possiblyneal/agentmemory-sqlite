# 2026-11-12 — Broker CPU route for eval summarize calls (#362, spec #359 lever 4)

**Commit:** `106f184a` (no repo code changed; the script lived in `tmp/`)
**Bench:** the 8 fixed summarize chunk prompts of [2026-11-07](./2026-11-07-eval-broker-throughput.md), replayed greedily against the broker
**N:** 8 chunks per run, 2 runs per setting; each prompt 13.3k to 16.9k tokens
**LLM:** local broker `Occult-Nail-1.0-35B-A3B-UD-Q4_K_XL`, `general-eval-b` on the `rocm10` GPU backend and on the `cpu` backend, `--parallel` 1 each
**Hardware:** AI machine `10.10.10.13`, Strix Halo unified-memory APU
**Embeddings:** none

## Headline

The CPU route adds no throughput that holds. With the GPU and CPU instances sharing a queue,
the 8 chunks took 282 and 300 s, against 318 and 236 s on the GPU instance alone. The CPU
took 2 of the 8 chunks at 135 to 164 s per call, and the run waited on its second one. On its
own the CPU instance needed 957 and 938 s (prefill about 190 tok/s per call, against 850 to
1,150 on the GPU).
Every setting repeats exactly once each chunk stays on one backend: 8 of 8 replies are
byte-identical across runs. But the GPU and the CPU give a different reply on all 8 chunks,
so a shared queue is deterministic only while placement holds, and placement depends on
timing. Nothing was adopted and no broker change was made.

## Per setting

Greedy (`temperature` 0, `seed` 42, `reasoning_effort` none, `max_tokens` 2048), one worker per
route pulling from a shared queue of the same 8 prompts, one warm-up call per route before the
clock. In run 2 of the GPU + CPU setting each chunk was pinned to the backend it had in run 1.

| Setting | Run | Wall | Output tok/s | Prompt tok/s | Mean / max call | Chunks on CPU | Replies identical to the other run | Decision lists identical |
|---|---|---|---|---|---|---|---|---|
| `--parallel` 1 GPU (`general-eval-b`) | 1 | 318 s | 17.0 | 367 | 40 / 86 s | — | 8 / 8 | 8 / 8 |
| | 2 | 236 s | 22.9 | 493 | 30 / 68 s | — | | |
| GPU + CPU route, shared queue | 1 | 282 s | 19.2 | 413 | 67 / 147 s | 2, 11 | 8 / 8 (pinned) | 8 / 8 |
| | 2 | 300 s | 18.0 | 388 | 67 / 164 s | 2, 11 | | |
| CPU route alone | 1 | 957 s | 4.2 | 122 | 120 / 144 s | all 8 | 8 / 8 | 8 / 8 |
| | 2 | 938 s | 4.3 | 124 | 117 / 171 s | all 8 | | |

- Equality is placement-independent: each chunk is compared with the same chunk on the same
  backend. Every GPU reply in the shared-queue runs equals the GPU-alone reply for that chunk,
  and every CPU reply equals the CPU-alone reply, in both runs (8 of 8 each way).
- The GPU and the CPU never agree: 0 of 8 replies and 0 of 8 decision lists match between
  the two backends. Decision counts move by up to 10 (chunk 5: none on the GPU, where the reply
  loops to the cap, and 10 on the CPU; chunk 20: 10 and 5; chunk 8: 6 and 3).
- The CPU slows when the GPU works. Its prefill ran at 191 and 192 tok/s alone and 138 and 126
  tok/s beside the GPU worker; decode at 12.6 to 13.7 tok/s alone and 11.6 to 12.2 beside it.
  The two share one memory bus. GPU prefill averaged 848 to 1,148 tok/s per call across runs.
- With 8 chunks the tail decides the wall. A CPU call takes 4 to 5 GPU calls' time, so the run
  ends on the CPU's second chunk. A combined rate of about 1.2x the GPU's would need a queue long
  enough to hide that tail, and it would still mix backends.
- Output tok/s is not comparable between backends: the GPU reply to chunk 5 loops to the
  2,048-token cap in every GPU run, while the CPU reply stops at 825. Compare prompt tok/s and wall.

## Conditions

- Window: `overflow_route` was removed from the live `general` route at 08:26:16 and put back
  at 09:23:41 (`PUT /api/advertised/route`). Afterwards every route's `{id, settings}` matched
  the snapshot taken before (748 of 748). The CPU backend had no instance at the start, so there
  were no live calls to drain.
- Live load (requests on `general`, sampled every 15 s): GPU run 1 averaged 2.9 (max 4), GPU run 2
  0.5 (max 2), shared queue 2.1 and 1.6 (max 4), CPU alone 1.4 and 0.8 (max 4). GPU run 2 is the
  fastest row because its load was lowest; GPU run 1 and shared-queue run 1 had similar load,
  and there the shared queue was 11% faster (282 against 318 s). In run 2 it was 27% slower (300 against 236 s).
- Runs were interleaved: GPU, shared queue and CPU for run 1, then shared queue, CPU and GPU for run 2.
- `max_tokens` is 2048, not the 8192 of 2026-11-07. A first GPU run at 8192 looped chunk 5 to
  8,192 tokens in 267 s, and the CPU would not have fit the one-hour window at that cap. Only the
  looping chunk is affected.
- On 2026-11-07 the same GPU setting did not loop on chunk 5 (a run totalled about 4,100 output
  tokens). Today it loops in all four GPU runs, so the GPU numerics changed between the two dates.
  Today's GPU numbers are not comparable with 2026-11-07's.

## Reproduce

Not committed (`tmp/` is private scratch). The method of [2026-11-07](./2026-11-07-eval-broker-throughput.md#reproduce),
with routes named directly: `rocm10/<model>/general-eval-b` and `cpu/<model>/general-eval-b`.
For the shared-queue setting, one worker per route takes the next prompt from one queue. Run 2
gives each worker the chunks its route served in run 1. A 429 or 503 is retried after 30 s, and
the call is timed from the attempt that succeeds. The CPU backend allows one instance, which the
live `general` route claims as its overflow. Freeing it means removing `overflow_route` from that
route for the window and putting it back after.

## Notes

- Do not mix backends in one replay. A summarize-bearing eval stays on the GPU `general-eval-b`
  instance at chunk concurrency 1 (`eval/README.md`).
