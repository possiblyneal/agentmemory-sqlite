# 2026-10-25 — Decisions dropped when a Session Summary is folded forward (#312)

**Commit:** control `b84e3614` (main), fix = local branch `wip/312-fold-append-decisions` over `b84e3614` (rejected, not merged)
**Bench:** `eval:fold-drift --batch 20` over the 3 longest Sessions in the #259 replay store, one run per arm; then `eval:replay --from-checkpoints` over that store with each arm's folded Summaries patched in, dev split (holdout not opened)
**N:** 3 Sessions of 654 to 816 Observations, 108 fold steps per arm; replay 40 probed checkpoints (one per Session), 337 prompts, 58 key items (55 file, 3 correction, 0 decision) plus 29 terse file needs, scored separately
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** linux x86_64, 8 cores, Node v22.23.2; the two arms' replay probes ran in parallel on one host
**Embeddings:** none for fold-drift; on-device MiniLM (replay default) for the replay
**LLM:** the Operator's OpenAI-compatible broker, model `general`, `SUMMARIZE_CHUNK_CONCURRENCY=1`, 900 s timeout; the replay probes make no LLM call

## Headline

Appending a fold's new decisions in code stops folds dropping decisions: 0 drops over 100
folds, against 426 drops by main's 83 (exact text; 405 by Jaccard). After the fold sequence the
3 Sessions hold 155 decisions against 15. No replay metric moves: every hit, Used item and
correction count is equal, and the fix injects 1.4% more characters. The corpus has no decision
key items, so it cannot show the gain this fix makes. The fix fails #312's acceptance (no drop,
at least one gain), is rejected, and is not merged.

## Decisions dropped by folds

A fold step drops a decision when the previous step's Summary held it and the fold's output does
not, matched by normalized exact text (word-set Jaccard >= 0.5 in brackets). Drops are summed over
folds, so a decision dropped, restored and dropped again counts twice; they are drop events, not
distinct decisions. A fallback is a step that re-summarized the whole Session instead of folding:
the fold reply failed to parse or validate, it held no decisions while the prior Summary had some,
or the fold prompt did not fit one chunk. These runs did not count what a fallback drops, so the
dropped columns cover folds only; `eval:fold-drift` now reports that loss apart as
`dropped-by-fallbacks`.

| Observations | main folds / fallbacks | main dropped | fix folds / fallbacks | fix dropped |
|---|---|---|---|---|
| 816 | 30 / 10 | 166 (159) | 36 / 4 | 0 (0) |
| 725 | 29 / 7 | 140 (137) | 32 / 4 | 0 (0) |
| 654 | 24 / 8 | 120 (109) | 32 / 0 | 0 (0) |
| **Total** | **83 / 25** | **426 (405)** | **100 / 8** | **0 (0)** |

| Observations | main full pass | main after folds | fix full pass | fix after folds |
|---|---|---|---|---|
| 816 | 8 | 7 | 10 | 10 |
| 725 | 36 | 4 | 6 | 33 |
| 654 | 18 | 4 | 61 | 112 |
| **Total** | **62** | **15** | **77** | **155** |

| Arm | Decision chars after folds | Mean chars per decision | Longest | Near-repeats (word Jaccard >= 0.6) |
|---|---|---|---|---|
| main | 2,203 | 147 | 237 | 0 |
| fix | 23,153 | 149 | 330 | 4 |

The full-pass column is the same code in both arms and varies between runs (the 725-Observation
Session gave 36 decisions in one run and 6 in the other), so it is a reference, not a result.
Matching fold-sequence decisions against the full pass's misses almost all of them in both arms:
the two passes word the same decision differently, so that count measures wording, not loss.

## Replay

| Arm | Injected items | Used | Injection chars | Injection hit | Search hit | Either | Terse Injection hit | Correction before repeat | session-start p50 / p99 | prompt-context p50 / p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| main | 329 | 93 | 236,653 | 48/58 | 15/58 | 50/58 | 20/29 | 2/3 | 19 / 68 ms | 13 / 272 ms |
| fix | 329 | 93 | 239,945 | 48/58 | 15/58 | 50/58 | 20/29 | 2/3 | 25 / 90 ms | 14 / 291 ms |

By kind (both arms equal): file 46/55 injected and 15/55 by search, correction 2/3 injected. Every
per-checkpoint line matches between arms. Latency is not attributable: the two probes shared a
host whose load average ran from 4 to 19 over the 9.6-hour run.

## Methodology

- The fix: `FOLD_SYSTEM` asks only for the decisions the new Observations make, and
  `mem::summarize` appends them to the prior Summary's list, dropping exact repeats. A
  whole-Session re-summarize (the fallback, `force`, or a stale count) still rebuilds the list.
- `--batch 20` approximates live Stop cadence: in the long Sessions a prompt arrives every 12
  Observations at the median and 32 at the mean, and a Stop folds once per prompt.
- 3 Sessions, not 10: each Session took 75 to 100 minutes per arm at chunk concurrency 1 (the
  broker answered 429s and timeouts at higher concurrency), so the run was cut to the 816-,
  725- and 654-Observation Sessions, the three longest, where folds are most numerous.
- `eval:replay --llm` cannot score this: it awaits one `/summarize` per Session, which never
  folds. Each arm's `foldedSummary` for the 3 Sessions was written into a copy of every #259
  checkpoint holding that Session (37 of 40 probed checkpoints differ between arms), and the
  same build probed both copies, so the Summaries are the only difference.

## Reproduce

```sh
# per arm (b84e3614 for main; the fix is c7d0c7ce on the Operator's local, unpushed branch
# wip/312-fold-append-decisions, described under Methodology), from the repaired last #259 checkpoint
npm ci && npm run build
SUMMARIZE_CHUNK_CONCURRENCY=1 AGENTMEMORY_LLM_TIMEOUT_MS=900000 \
  npm run eval:fold-drift -- --store <checkpoint> --longest 3 --batch 20
# patch each arm's foldedSummary into a copy of every #259 checkpoint that holds the Session
# (one-off script, not committed), then probe each copy with the same build:
npm run eval:replay -- --from-checkpoints <patched copy> --keyed-only --cap 1000 --min-turns 2 \
  --max-prompts 40 --split dev --root <frozen copy> --projects=<list> --instance <N>
```

## Notes

- The fix's remaining loss is the fallback: a fold that falls back (an empty narrative fails
  validation, say) re-summarizes the whole Session and rebuilds the list from scratch. On the
  816-Observation Session the list grew to 40 and a fallback cut it back to 10 or fewer.
- Injection shows the first 10 decisions of a Summary. With an appended list those are the
  Session's oldest 10, where a rewritten list put whatever the model kept first.
- The replay harness re-embeds every seeded checkpoint at boot (no recorded vector space). That
  fill blocked the daemon's event loop past `readyz` and outran the 10-minute fill limit on the
  larger checkpoints, so `eval/runner/sandbox.ts` now waits up to 5 minutes for a `readyz` reply
  and 45 minutes for the fill.

## Rejected levers

- **Code-built append of fold decisions** (this fix): stops the drop, but replay shows no gain
  on a corpus with no decision key items; it would need a corpus that scores decisions.
- **Model rewrites the whole list on each fold** (main): drops 426 decisions over 83 folds.
- **Longer sandbox boot timeout** (30 s to 120 s): still missed `readyz` under load; the
  per-request wait replaced it.
- **Probing the arms in parallel at the 10-minute fill limit**: the fill timed out.
- **`eval:replay --llm` as the replay arm**: it never folds, so it cannot see this change.
