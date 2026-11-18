# 2026-11-18 — prompt-submit Injection wait, one week after #371 (#397)

**Commit:** live daemon on `bcfc8fa3` from 2026-11-15T21:57Z, `7a838812` from 2026-11-18T03:04Z; earlier days on the #371 deploy
**Bench:** the Operator's live store, read-only: served is `mem:injections` rows with `source: "prompt-submit"`, missed is `~/.agentmemory/missed-injections.jsonl` lines with `hook: "prompt-submit"`
**N:** 2,038 prompt-submit Injections, 2026-11-12T03:33Z to 2026-11-18T04:00Z
**K:** an Injection is served or missed whole
**Hardware:** Linux 6.12, 12 cores, Node 22.23.4
**Embeddings:** on-device
**LLM:** none; the reranker gate (`ai.lan:9202`) runs inside the measured requests

## Headline

At the 1500 ms wait (`INJECT_TIMEOUT_MS`, `src/hooks/_missed-injection.ts`), 145 of 2,038
prompt-submit Injections were missed over the week after #371, 7.1%: 143 timeouts, one
connection error, one 503. Before #371 the rate was 29–32% a day. The wait stays at 1500 ms.

## Per day

Rate = missed / (served + missed). 2026-11-12 counts from the #371 deploy at 03:33Z.

| Day (UTC) | Served | Missed | Rate | Note |
|---|---|---|---|---|
| 11-12 | 301 | 20 | 6.2% | |
| 11-13 | 695 | 74 | 9.6% | |
| 11-14 | 291 | 20 | 6.4% | |
| 11-15 | 272 | 20 | 6.8% | 14 misses at 04Z, during a full local test run |
| 11-16 | 200 | 4 | 2.0% | #411, #413, #416, #417 deployed late on 11-15 |
| 11-17 | 9 | 0 | 0.0% | little use |
| 11-18 | 125 | 7 | 5.3% | all 7 between 02:40Z and 03:48Z, the busiest hours |

## Why the wait stays

- Where the hour is known, misses cluster in busy hours and during local test runs (11-15
  04Z, 11-18 02Z–03Z) rather than spreading through ordinary use.
- The same constant bounds the daemon's prompt-context `ShedQueue` (`src/triggers/api.ts`),
  so a longer wait lengthens the delay before every prompt the daemon is slow on, and lets a
  burst queue longer before it sheds.
- Nothing records how late a missed Injection would have finished, so no wait can be priced
  against the Injections it would recover.
