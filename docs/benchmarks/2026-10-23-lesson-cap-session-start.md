# 2026-10-23 — Lesson near-twin cap at session start (#294)

**Commit:** before `444bb900` (main); after: `fix/lesson-cap-session-start` (same base, the cap in `mem::context`)
**Bench:** supersession, dev split (`runner/supersession.ts`); `eval:suite --tier fast` (coding-life, PrecisionMemBench, LongMemEval sample); `eval:gate`
**N:** supersession 110 cases (5 per Lesson cell); suite as listed below
**K:** 5 (search); an Injection is scored whole
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** none for supersession and the gate; the suite's own defaults otherwise
**LLM:** none

## Headline

Adopted. Lesson / session start falls from **1.00** stale-first to **0.00** (5/5 fresh-first). No other supersession cell moves, all 15 fast-suite metrics are identical to the baseline, and `eval:gate` passes with p95 3 ms (session start) and 7 ms (prompt submit) against the 500 ms ceiling.

## Lever

`mem::context` scored Lessons as project-weighted confidence over a 1%-per-day recency divisor. The bench saves the stale Lesson three times and the newer one once, milliseconds apart, so the divisor could not separate them and the reinforced confidence won. Session start now runs `capBehindNewer` (`src/functions/recency-cap.ts`) over the project's Lessons before its top-10 cut, dated by `lastReinforcedAt` else `createdAt` as `mem::lesson-recall` does (`lastActiveAt`, `src/functions/lessons.ts`). A Lesson whose text overlaps a newer one's by Jaccard ≥ 0.5 is capped at 0.99 of its score. The bench's saves land in different milliseconds, so the cap's equal-timestamp skip does not apply.

## Supersession

| Kind | Variant | Surface | Before | After | docs/supersession.md |
|---|---|---|---|---|---|
| Lesson | reinforced | search | 0.00 | 0.00 | T11 |
| Lesson | reinforced | session-start | **1.00** | **0.00** | T12, T12r |
| Observation | stale matches more | search | 0.80 | 0.80 | T21 (#295) |

Every other cell is 0.00 before and after.

## Fast suite (`--against base-294`)

| Metric | Before | After |
|---|---|---|
| coding-life search recall / precision / hit | 1.000 / 0.708 / 0.833 | same |
| coding-life session-start recall / precision / hit | 0.625 / 1.000 / 1.000 | same |
| coding-life prompt-submit recall / precision / hit | 0.861 / 1.000 / 1.000 | same |
| PMB pass / activePass / precision / recall | 0.447 / 0.391 / 0.440 / 0.942 | same |
| LongMemEval recall@5 / hit | 0.896 / 0.958 | same |

All Δ 0.000. No suite fixture holds two Lessons that restate each other, so the cap does not fire there.

## Reproduce

```sh
npm ci && npm run build
npm run eval:supersession -- --instance 25
LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json npm run eval:suite -- --tier fast --label <label> --against base-294
npm run eval:gate
```

## Notes

- The cap compares every pair of the project's Lessons, O(n²) Jaccard on short texts, the same work `mem::lesson-recall` does on up to 100 hits. Session start latency in the gate is unchanged.
- A stale Lesson reinforced after the newer one was saved still leads, as in search: a re-save is the Operator restating it.
