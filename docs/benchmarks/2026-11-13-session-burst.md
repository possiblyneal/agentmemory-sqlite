# 2026-11-13 — Session burst first Injections (#400)

**Commit:** `860f27f3` (main) plus the change under test, as built per arm
**Bench:** `npm run eval:burst` (`eval/runner/burst.ts`): 32 virtual Sessions opening within 2 s over a restarted daemon, hook-shaped traffic, calls abandoned at the hooks' 1,500 ms deadline
**N:** 32 Sessions per run, 5 runs per arm; 20,000 seeded Observations (12 Sessions of one project, chunks of this repo's own text)
**K:** none (latency only)
**Hardware:** Linux 6.12, 12 cores, Node 22, BM25 only, no LLM; shared with other agents' daemons and evals, so the load average before each run is listed
**Arms:** `main` (before), `shed` (a FIFO queue with shedding in `api::prompt-context`), `cap` (prefix-filtered near-twin cap, no queue), `both` (this change)

## Headline

At 32 Sessions opening together, `main` answers a median 7 of 32 first prompt-submit Injections inside 1,500 ms (1 to 9 over five runs). The queue alone raises it to 11, the faster near-twin cap alone to 10, and both to a median 21 of 32 (16 to 32; every run at or above half). Session-start Injections were 32 of 32 in every arm but one run of `main` (31). `/livez` max fell from 2.8 to 5.0 s on `main` to 0.25 to 0.9 s with both.

The cost behind it: one `prompt-context` takes 215 ms (p95 255) alone on this store, and 157 ms of that is `capOlderNearTwins` (a pairwise Jaccard over every hit, CPU profile of 60 serial requests). A burst of 32 is then about 7 s of serial work against a 1,500 ms deadline, whatever the order. The queue only chooses who is late; the cap fix makes the work 3 to 4 times smaller.

## First prompt of the burst

"In time" counts first `prompt-context` calls answered within 1,500 ms; a call still pending then reads as 1,500 ms and counts late. p50 is therefore 1,500 whenever fewer than half are in time. Later p95 is the p95 of the Sessions' later prompts (every 8th tool call).

| Arm | Run | Load before | First in time | First p50 (ms) | First p95 (ms) | Session-start in time | Later p95 (ms) | `/livez` max (ms) |
|---|---|---|---|---|---|---|---|---|
| main | 1 | 5.7 | 4 / 32 | 1,500 | 1,501 | 32 / 32 | 1,505 | 5,001 |
| main | 2 | 6.2 | 1 / 32 | 1,501 | 1,503 | 32 / 32 | 1,502 | 5,001 |
| main | 3 | 7.4 | 7 / 32 | 1,500 | 1,501 | 31 / 32 | 1,501 | 3,797 |
| main | 4 | 2.9 | 9 / 32 | 1,500 | 1,501 | 32 / 32 | 1,501 | 2,794 |
| main | 5 | 2.6 | 7 / 32 | 1,500 | 1,501 | 32 / 32 | 630 | 3,872 |
| shed | 1 | 2.6 | 13 / 32 | 1,500 | 1,501 | 32 / 32 | 1,031 | 839 |
| shed | 2 | 2.8 | 9 / 32 | 1,500 | 1,501 | 32 / 32 | 474 | 407 |
| shed | 3 | 2.7 | 10 / 32 | 1,500 | 1,501 | 32 / 32 | 797 | 1,003 |
| shed | 4 | 2.5 | 13 / 32 | 1,500 | 1,501 | 32 / 32 | 1,501 | 906 |
| shed | 5 | 2.1 | 11 / 32 | 1,500 | 1,501 | 32 / 32 | 399 | 248 |
| cap | 1 | 2.9 | 8 / 32 | 1,500 | 1,525 | 32 / 32 | 461 | 1,148 |
| cap | 2 | 2.4 | 4 / 32 | 1,500 | 1,501 | 32 / 32 | 495 | 1,936 |
| cap | 3 | 1.8 | 19 / 32 | 1,330 | 1,501 | 32 / 32 | 488 | 1,310 |
| cap | 4 | 2.0 | 16 / 32 | 1,383 | 1,501 | 32 / 32 | 379 | 1,256 |
| cap | 5 | 2.0 | 10 / 32 | 1,500 | 1,501 | 32 / 32 | 508 | 2,063 |
| both | 1 | 1.9 | 20 / 32 | 1,354 | 1,501 | 32 / 32 | 330 | 250 |
| both | 2 | 1.5 | 25 / 32 | 1,067 | 1,501 | 32 / 32 | 280 | 380 |
| both | 3 | 1.9 | 32 / 32 | 774 | 1,317 | 32 / 32 | 399 | 289 |
| both | 4 | 1.9 | 21 / 32 | 952 | 1,501 | 32 / 32 | 361 | 896 |
| both | 5 | 2.6 | 16 / 32 | 1,451 | 1,501 | 32 / 32 | 472 | 248 |

| Arm | First in time, median (runs) | Later p95 median (ms) | `/livez` max (ms) |
|---|---|---|---|
| main | 7 (4, 1, 7, 9, 7) | 1,501 | 5,001 |
| shed | 11 (13, 9, 10, 13, 11) | 797 | 1,003 |
| cap | 10 (8, 4, 19, 16, 10) | 488 | 2,063 |
| both | 21 (20, 25, 32, 21, 16) | 361 | 896 |

## Gate

`npm run eval:gate` with both changes: every metric equal to its baseline (search recall 0.969, session-start 0.813, prompt-submit 0.907), session-start p95 3 ms and prompt-submit p95 7 ms against the 500 ms ceilings. The prefix filter returns the same caps as the pairwise scan (`test/recency-cap.test.ts` checks 40 random rounds of 60 records, cascades and token-less texts included).

## Method

- Driver: `eval/runner/burst.ts`. Per Session: `POST /session/start` (timed, 1,500 ms), a first prompt 1 to 3 s later (`/prompt-context`, timed, 1,500 ms, then a `prompt_submit` Observation), a `post_tool_use` Observation every 3 s (0.5x to 1.5x), a prompt every 8th call, for 30 s; `/livez` every 50 ms beside it. Seeds `prng(1000 + run)`, the same burst for every arm.
- The store is built once through the daemon (`VACUUM INTO` a seed file) and each run restarts a daemon from a copy, so BM25 is rebuilt from content every run and every arm starts equal.
- Arms differ by `--cli`: `dist/` copied aside before and after each change. Port block `--instance 47`, per-run HOME and store under `tmp/eval-sandbox/`.
- The host was not idle: other agents' daemons and evals kept the load at 1.5 to 3 for most runs and 5.7 to 7.4 for the first three `main` runs; the daemon under test accounts for about 1 of it. `main` runs 4 and 5 (load 2.9, 2.6) gave 9 and 7, in line with runs 1 to 3.
- The seed text is this repository's source, which has more near-twin overlap than real Observations, so `capOlderNearTwins` weighs more here than on the live store; the live daemon's own profile (2026-11-13 concurrent Sessions load) also put it first at 7.6 s of a 63 s busy run.

## Notes

- The queue sheds a request queued past `INJECT_TIMEOUT_MS` (it answers 503 to a hook that already gave up) and runs the rest one at a time in arrival order. Alone it raised in-time first prompts from 7 to 11 of 32 and cut later p95 from 1,501 to 797 ms, because abandoned requests are no longer computed.
- Not measured: steady-state load, and a live store with a local embedder.
