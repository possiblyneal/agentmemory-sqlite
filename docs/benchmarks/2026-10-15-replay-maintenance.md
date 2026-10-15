# 2026-10-15 — replay eval, how far maintenance can shrink the store

**Commit:** `7c0415f` plus the `--maintenance` runner flag (#219)
**Bench:** replay of the Operator's own Claude Code transcripts (`npm run eval:replay`; private data, aggregates only), probed once per maintenance pass from the LLM-compressed checkpoints of [2026-10-15 replay gate](2026-10-15-replay-gate.md)
**N:** 40 probed Sessions in 7 repositories, 337 probed prompts, 58 headline answer-key items (55 files, 3 repeated corrections, 0 revisited decisions) plus 29 terse-prompt file needs scored apart
**K:** 5 for the `smart-search` baseline; a prompt-context Injection is scored whole
**Hardware:** linux 6.12, 8 cores, node 22.23
**Embeddings:** on-device (local MiniLM); `RERANK_ENABLED` off
**Injection Gate:** off (`AGENTMEMORY_PROMPT_RERANK=off`) in every pass
**LLM:** none in the probe passes; the checkpoints were built as in the gate scorecard

## Headline

The safe limit is a 47% shrink. Eviction cuts this store by up to 47% without losing a single key item that the baseline delivered, on any path. **`evict-cap:1000` is the most aggressive setting that keeps key items delivered at the baseline**: it keeps 1,000 Observations per project and cuts the final store from 77.3 MB to 40.8 MB. Injection loses no item and gains none (44 / 58), and search gains 2 items and loses none. `evict-importance:5` (−13%) is the safe importance floor.

Deeper passes keep the totals at baseline but trade items. They lose some items the baseline delivered and pick up others:

- `evict-importance:8` shrinks the store 88% (to 9.0 MB) and still scores 45 / 58 by Injection. But it loses 3 items the baseline delivered and gains 4 others, and search alone changes 24 of 58 items.
- Removing every Observation is the first pass whose total falls (Injection 40 / 58).

So this run does not show that eviction improves Recall. It shows that a modest floor or cap is free, and that deeper ones change *which* items arrive.

At the measured commit, the daemon's own defaults (`evict`, `auto-forget`) remove nothing here, because every Observation is under five weeks old. Following this run, #225 makes `evict-importance:5` the default Eviction floor, for Observations at least a day old so a Session is summarized and graph-extracted before its rows go.

## Per pass

Store is the live bytes (pages in use) of the final checkpoint after its pass. Observations is how many the final checkpoint keeps, of 15,042. Lost / gained compares each headline key item with the baseline on the same path: lost was delivered by the baseline and not by the pass; gained is the reverse.

| Pass | Observations kept | Store | Injection | Search | Either | Lost / gained: Injection, search, either | Used / injected | Chars per used item |
|---|---|---|---|---|---|---|---|---|
| none (baseline) | 15,042 | 77.3 MB | 44 / 58 | 13 / 58 | 46 / 58 | — | 67 / 542 (12.4%) | 4,411 |
| `evict` (defaults at `7c0415f`) | 15,042 | 77.3 MB | 44 | 13 | 46 | 0/0, 0/0, 0/0 | 67 / 542 | 4,411 |
| `auto-forget` | 15,042 | 77.3 MB | 44 | 13 | 46 | 0/0, 0/0, 0/0 | 67 / 542 | 4,411 |
| `evict-importance:3` | 14,783 | 76.9 MB (−0.5%) | 44 | 15 | 47 | 0/0, 0/2, 0/1 | 67 / 544 | 4,435 |
| `evict-importance:4` | 13,872 | 74.7 MB (−3%) | 44 | 15 | 47 | 0/0, 0/2, 0/1 | 66 / 542 | 4,542 |
| **`evict-importance:5`** | **11,649** | **67.4 MB (−13%)** | **44** | **16** | **47** | **0/0, 0/3, 0/1** | 68 / 545 | 4,477 |
| `evict-importance:6` | 7,011 | 44.8 MB (−42%) | 45 | 18 | 47 | 0/1, 1/6, 1/2 | 83 / 555 (15.0%) | 3,564 |
| `evict-importance:7` | 2,488 | 21.0 MB (−73%) | 44 | 19 | 47 | 1/1, 3/9, 2/3 | 86 / 553 (15.6%) | 3,468 |
| `evict-importance:8` | 233 | 9.0 MB (−88%) | 45 | 19 | 47 | 2/3, 9/15, 3/4 | 70 / 456 (15.4%) | 3,787 |
| `evict-importance:10` (no Observations) | 0 | 7.7 MB (−90%) | 40 | 0 | 40 | 4/0, 13/0, 6/0 | 43 / 218 | 3,986 |
| `evict-cap:2000` | 11,884 | 66.1 MB (−15%) | 44 | 14 | 47 | 0/0, 0/1, 0/1 | 69 / 547 | 4,341 |
| **`evict-cap:1000`** | **6,270** | **40.8 MB (−47%)** | **44** | **15** | **47** | **0/0, 0/2, 0/1** | 70 / 540 | 4,261 |
| `evict-cap:500` | 3,270 | 25.3 MB (−67%) | 43 | 18 | 45 | 1/0, 1/6, 1/0 | 83 / 537 | 3,516 |

Other Goal lines, for the baseline and the recommended pass:

| Goal line | Measure | Baseline | `evict-cap:1000` |
|---|---|---|---|
| Right moment | by rule, either: file / correction / decision | 44 / 55, 2 / 3, — / 0 | 45 / 55, 2 / 3, — / 0 |
| Right moment | terse prompts, Injection / search / either | 20 / 29, 12 / 29, 22 / 29 | 20 / 29, 15 / 29, 23 / 29 |
| Right scope | injected items from another project | 0 / 542 | 0 / 540 |
| Durable beats recent | repeated corrections injected before the repeat | 2 / 3 | 2 / 3 |
| Least record | store bytes per distinct used item | 1.38 MB (56 items) | 692 KB (59 items) |
| Never on the critical path | session-start p50 / p99 | 11 ms / 45 ms | 11 ms / 77 ms |
| Never on the critical path | prompt-context p50 / p99 | 27 ms / 369 ms | 20 ms / 164 ms |
| Never on the critical path | hook probes over 1.5 s | 0 of 377 | 0 of 377 |

## Methodology

- **One compression for every pass.** Every pass restores the same 40 checkpoints that the gate scorecard's save pass wrote (`tmp/eval-replay/ckpt/checkpoints`), each into a fresh sandbox with the LLM off. So the only difference between passes is the maintenance call.
- **The pass runs after the vector fill and before the first probe.** `--maintenance` makes one REST call per checkpoint (`eval/README.md`, Replay). The `evict-*` passes seed `mem:config/eviction` before the daemon boots:
  - stale-Session recovery is disabled (`staleSessionDays` 36,500), because it would need the LLM;
  - `evict-importance:N` opens the age gate (`lowImportanceMaxDays` 0) and evicts every Observation with importance below N;
  - `evict-cap:N` evicts the lowest-importance Observations past N per project.
- **Store is live bytes**, `(page_count − freelist_count) × page_size` of the final checkpoint, so eviction is not hidden by pages SQLite has not returned to the file. The baseline reads 77.3 MB live against 77.5 MB on disk in the gate scorecard; its Recall numbers match the gate-off arm exactly.
- **No graph rows were removed.** `graphNodes` and `graphEdges` are 0 in every pass, so the shrink is Observation rows and their vectors.
- **Importance distribution of the final checkpoint:** 1: 54, 2: 205, 3: 911, 4: 2,223, 5: 4,638, 6: 4,523, 7: 2,255, 8: 230, 9: 3.
- Probe passes ran up to four at once on `--instance 9`–`12`, so latency is an upper bound. Every search over 1.5 s (40 per pass) is the first smart-search after a restore, as in the gate scorecard.

## Reproduce

```sh
npm ci && npm run build
COMMON=(--projects=<every directory, comma-separated> --cap 1000 --min-turns 2 --keyed-only
        --from-checkpoints tmp/eval-replay/ckpt/checkpoints)
AGENTMEMORY_PROMPT_RERANK=off npm run eval:replay -- "${COMMON[@]}" --out tmp/eval-replay/shrink-baseline
for pass in evict auto-forget evict-importance:{3,4,5,6,7,8,10} evict-cap:{2000,1000,500}; do
  AGENTMEMORY_PROMPT_RERANK=off npm run eval:replay -- "${COMMON[@]}" --maintenance "$pass" \
    --out "tmp/eval-replay/shrink-$pass"
done
```

The checkpoints come from the save pass in the gate scorecard. You need your own `~/.claude/projects`, and your numbers will differ.

## Notes

- **Verdict: a modest floor or cap is free; deeper ones trade items.** Through `evict-importance:5` and `evict-cap:1000` (−13% and −47%), no headline item that the baseline delivered is lost on any path. From `evict-importance:6` on, every pass loses at least one such item. It may gain others, so the totals stay at baseline, but an Agent that needed the lost item gets it no longer.
- **The ticket's rule alone would pick `evict-importance:8`.** Its totals stay at baseline (45 / 58 Injection, 47 / 58 either). But they hide churn: 3 items lost and 4 gained on either path, and 24 of 58 changed by search alone. This scorecard does not recommend it.
- **Eviction does not clearly improve Recall.** Search totals rise from 13 to 15–19 and the used share from 12.4% to about 15.5%, which suggests low-importance Observations crowd the top 5. But the deep passes that raise these numbers most also lose items. One store, one Operator and a 58-item key cannot separate a real gain from a swap of near-ties.
- **Where the totals fall.** `evict-cap:500` is the only pass with Observations left whose total drops (Injection 43, either 45). A cap ranks within each project, so at 500 the largest projects (up to 3,500 Observations) cut into higher-importance rows.
- **Search depends on Observations; Injection mostly does not.** With no Observations at all, search delivers 0 / 58, while Injection still delivers 40 / 58 from Session summaries and semantic memories.
- **The defaults at `7c0415f` never fire on a store this young.** Default eviction there needs Observations older than 90 days with importance below 3, and auto-forget needs ones older than 180 days with importance ≤2. Every Observation here is under five weeks old. This run measures what a floor or cap would do, not what that schedule did.
- **Limits of this run.**
  - One `--keyed-only` store holds fewer distractors than a live one.
  - The run is dev split only; no holdout checkpoints exist.
  - The importance scores come from one LLM's compression.
  - Each checkpoint is evicted once rather than continuously as a Session adds Observations.
  - 55 of 58 headline items are files, the 3 corrections score 2 / 3 in every pass, and there are no decisions.

  The Operator adopted `evict-importance:5` as the default (#225) on this evidence. A store built without `--keyed-only`, and holdout checkpoints, would test it further.
