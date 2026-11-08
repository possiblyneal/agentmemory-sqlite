# 2026-11-07 — Prompt caching on the eval broker profile (#364, spec #359)

**Commit:** `cc5d3af0` (no repo code changed; the script lived in `tmp/cache/`)
**Bench:** two fixed greedy workloads of real summarize prompts, replayed against the broker one call at a time
**N:** `chunks` 8 prompts (13.5k to 14.7k tokens, one of 7.1k), `grow` 8 prompts (0.5k to 13.5k tokens); 3 runs per setting and workload (baseline: 3 on `chunks`, 3 on `grow`)
**LLM:** local broker `Occult-Nail-1.0-35B-A3B-UD-Q4_K_XL`, `general-eval-b` boot args (`--parallel 1`, `--kv-unified`, ctx 204800) with the cache flags varied
**Hardware:** AI machine `10.10.10.13`, Strix Halo unified-memory APU
**Embeddings:** none

## Headline

Caching works on this model with the vision projector loaded, and it does not speed up the
summarize workload an eval runs. `--cache-ram 8192 --ctx-checkpoints 8` served 100% of prompt
tokens from cache on a replay of prompts already seen (140 to 157 s against 266 to 288 s) but
on distinct prompts it cached 542 of 14,000 tokens per call, the shared system prompt, and was
no faster (298 s against 266, 268 and 288 s; prefill 139 s against 128 to 134 s). Dropping the
projector gave no cached tokens on its own and no speed-up. Every changed setting also changed
the reply bytes from the baseline's (0 of 8 equal in every run), and the cached settings
repeat 3 to 8 of 8, so nothing was adopted and the broker repo is unchanged.

## Per setting

Greedy (`temperature` 0, `seed` 42, `reasoning_effort` none, `max_tokens` 8192), one call at a
time (the profile has one slot), one warm-up call before the clock. `prompt` and `cached` are the
broker's `usage.prompt_tokens` and `prompt_tokens_details.cached_tokens`; prefill is the sum of
llama.cpp's `timings.prompt_ms`.

### `chunks` (8 session chunks, 106k prompt tokens)

| Setting | Run | Wall | Prefill | Cached tokens | Output tok/s |
|---|---|---|---|---|---|
| baseline `general-eval-b` (`--cache-ram 0 --ctx-checkpoints 0`, projector) | 1 | 266 s | 133 s | 0 | 16.8 |
| | 2 | 268 s | 128 s | 0 | 16.7 |
| | 3 | 288 s | 134 s | 0 | 15.4 |
| checkpoints + RAM cache, projector kept | 1 | 298 s | 139 s | 3,794 (3.6%) | 15.2 |
| | 2 | 140 s | 1 s | 105,963 (100%) | 31.9 |
| | 3 | 151 s | 1 s | 105,963 (100%) | 29.4 |
| projector dropped, caches off | 1 | 287 s | 131 s | 0 | 15.5 |
| | 2 | 287 s | 144 s | 0 | 15.7 |
| | 3 | 293 s | 147 s | 0 | 15.4 |
| both | 1 | 317 s | 143 s | 3,794 (3.6%) | 13.3 |
| | 2 | 157 s | 1 s | 105,963 (100%) | 27.2 |
| | 3 | 146 s | 1 s | 105,963 (100%) | 28.8 |

Runs 2 and 3 resend the exact prompts of run 1, so a cache hit there is the best case. In run 1
the cache holds only what a call has in common with the one before it: the 542-token system
prompt (`SUMMARY_SYSTEM`), 3.6% of the prompt. That buys nothing measurable: prefill 139 s and
143 s against 128 to 134 s.

### `grow` (8 prompts, the first 12% to 100% of one chunk's Observations, 60k tokens)

| Setting | Run | Wall | Prefill | Cached tokens | Output tok/s |
|---|---|---|---|---|---|
| baseline | 1 / 2 / 3 | 175 / 193 / 186 s | 71 / 77 / 78 s | 0 | 20.0 / 19.9 / 20.2 |
| checkpoints + RAM cache | 1 | 182 s | 49 s | 17,271 (28.8%) | 21.5 |
| | 2 / 3 | 122 / 119 s | 1 s | 59,974 (99.9%) | 32.3 / 33.0 |
| projector dropped | 1 / 2 / 3 | 197 / 202 / 203 s | 78 / 76 / 78 s | 0 | 19.0 / 20.1 / 20.0 |
| both | 1 | 183 s | 53 s | 17,271 (28.8%) | 20.4 |
| | 2 / 3 | 156 / 149 s | 1 s | 59,974 (99.9%) | 24.2 / 25.2 |

`grow` models a Session summarized again as it gets longer. Run 1's cached tokens are 542 per
call plus one whole prompt (the 13.5k-token prompt that `chunks` run 1 had already sent), not a
shared growing prefix: `buildSummaryPrompt` opens with `Session observations (N total):`, so the
first line differs as soon as N does and the shared prefix ends right after the system prompt. Wall time did not improve (182 s against 175 to 193 s) even though prefill fell by
22 s, because decode dominates here (3.9k output tokens at about 20 tok/s).

## Repeat equality

Replies equal byte for byte, of 8, between runs of one setting:

| Setting | `chunks` 1-2 / 2-3 / 1-3 | `grow` 1-2 / 2-3 / 1-3 | Against baseline run 1 |
|---|---|---|---|
| baseline | 7 / 0 / 0 | 4 / 0 / 0 | |
| checkpoints + RAM cache | 3 / 7 / 3 | 5 / 8 / 5 | 0 / 0 / 0, 0 / 0 / 0 |
| projector dropped | 7 / 8 / 7 | 4 / 8 / 4 | 0 / 0 / 0, 0 / 0 / 0 |
| both | 3 / 6 / 3 | 6 / 7 / 6 | 0 / 0 / 0, 0 / 0 / 0 |

- The baseline did not repeat 8 of 8 here, unlike #362: 7 and 4 of 8 between its first two
  runs on one instance. Its run 3 ran on a freshly started instance (the broker evicted the
  first to fit the other settings) and matched neither earlier run (0 of 8 on both workloads).
  Every setting repeats best between runs 2 and 3, which share one instance, and worst across
  an instance restart, so the instance, not only the flags, moves the numerics. #362's 8 of 8
  holds only inside a quiet stretch of one instance; the live daemon's traffic (below) is the
  likeliest disturbance, untested.
- A cold run (1) and a fully cached run (2) differ in 5 of 8 replies on `chunks` and 2 to 3 of 8 on `grow`: a prefix
  restored from a checkpoint is not numerically the same state as one prefilled in place.
  Between two fully cached runs (2, 3) 6 to 8 of 8 matched, still not all.
- The reply bytes of every changed setting differ from the baseline's in all 8 of 8, including
  the projector-only setting that caches nothing. So any of these settings would break
  comparison with a baseline or stored summary made on `general-eval-b` today, and the repo
  rule that a baseline is compared only with a run on the same setting would apply.

## Conditions

- The live daemon's `general` profile and its CPU copy served traffic on every run. The broker
  evicted the idle live `general` instance (4 days up) when the first cached profile needed the
  memory (host budget), and it reloaded within 15 s; no live request failed (no non-200
  `general` request in the broker log for the 10 minutes after the eviction, the only stretch checked). Counts of `general` requests during a
  run (broker `/metrics` delta) were 0 to 10 per run with three bursts of 789 to 2,020 during
  `grow` run 1 or 2 right after a reload, while the daemon drained its queue; the baseline's runs 1
  and 2 did not record the count, so the contention column for them is blank. Compare settings
  by run 2 and 3, not run 1, where the burst fell.
- Temporary profiles `general-eval-cache`, `general-eval-nommproj` and `general-eval-both`
  (copies of `general-eval-b` with `--cache-ram 8192 --ctx-checkpoints 8` and/or `--mmproj` and
  its path removed) were added with `POST /api/profiles` and given an alias with
  `PUT /api/advertised/route`, which a profile needs before `/v1/chat/completions` accepts its
  name. All were deleted afterwards; the broker repo and the live `general` profile are unchanged.
- The prompts are 13.5k to 14.7k tokens against #362's 13.3k to 16.9k, built from another
  Session (816 Observations, 15 chunks); the baseline was re-measured here, not taken from #362.

## Reproduce

Not committed (`tmp/` is private scratch). Build the prompts with `buildSummaryPrompt` over the
Observations of Session `ab7a81df` in the replay checkpoint `053-706f4b9b`, greedy-packed to
about 14.5k tokens (8 of its 15 chunks, evenly spaced; `grow` slices the first chunk at 12, 22,
34, 46, 58, 70, 85 and 100%). POST each to `/v1/chat/completions` with the sampling above
through an undici dispatcher with no header or body timeout and write each finished (setting,
workload, run) to its own file so a restart skips it.

## Notes

- A workload that resends the same prompt is where this cache pays: the retry of a failed
  summarize (`rejectionNote` is appended, so the whole prefix is cached) and a rerun of an
  unchanged Session. The summarize path sends no such repeat often enough to measure here, and
  its fold calls are short (prior summary plus a few Observations).
- With the projector loaded and no image in the request, llama.cpp still cached prefixes on this
  build (`b11870`); the ticket's premise that the projector disables reuse does not hold for a
  text-only request.
