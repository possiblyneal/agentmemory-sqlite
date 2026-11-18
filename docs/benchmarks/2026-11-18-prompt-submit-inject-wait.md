# 2026-11-18 — prompt-submit Injection wait raised to 2500 ms (#397)

**Commit:** live daemon on `bcfc8fa3` from 2026-11-15T21:57Z, `7a838812` from 2026-11-18T03:04Z; earlier days on the #371 deploy
**Bench:** the Operator's live store, read-only: served is `mem:injections` rows with `source: "prompt-submit"`, missed is `~/.agentmemory/missed-injections.jsonl` lines with `hook: "prompt-submit"`
**N:** 2,036 prompt-submit Injections, 2026-11-12T03:33Z to 2026-11-18T04:00Z
**K:** an Injection is served or missed whole
**Hardware:** Linux 6.12, 12 cores, Node 22.23.4
**Embeddings:** on-device
**LLM:** none; the reranker gate (`ai.lan:9202`) runs inside the measured requests

## Headline

At the 1500 ms wait, 145 of 2,036 prompt-submit Injections were missed over the week after
#371, 7.1%: 143 timeouts, one connection error, one 503. Before #371 the rate was 29–32% a
day. 116 of the 143 timeouts match a served `mem:injections` row within 2 s, the daemon
finishing after the hook gave up; 85 of those 116 finished within 1 s of the deadline. The
prompt-submit wait is raised to 2500 ms (`PROMPT_INJECT_TIMEOUT_MS`,
`src/hooks/_missed-injection.ts`), which would have served about 85 of the 143. Session start
keeps 1500 ms.

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
| 11-18 | 123 | 7 | 5.4% | all 7 between 02:40Z and 03:48Z |

## How late a miss finished

The daemon records a served row even after the hook has aborted (`noteInjection`,
`src/triggers/api.ts`), so a timeout followed by a served row of the same hook within 2 s is a
late Injection. Lateness is the served row's time minus the timeout's.

| Matched | p25 | p50 | p75 | p90 | ≤ 0.5 s | ≤ 1 s |
|---|---|---|---|---|---|---|
| 116 of 143 | 0.23 s | 0.56 s | 1.05 s | 1.47 s | 54 | 85 |

Served counts include those late rows, so 7.1% is a lower bound on the miss rate.

## Cost

The prompt-context `ShedQueue` (`src/triggers/api.ts`) sheds at the same deadline, so a burst
queues up to 2500 ms before it sheds, and a slow turn delays the prompt up to 1 s longer before
the Agent sees it. The daemon was finishing that work anyway; the extra wait is what it costs.
