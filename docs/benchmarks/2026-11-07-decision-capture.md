# 2026-11-07 — Never-captured key decisions are in the Observations

**Commit:** main `4fb24627` (checkpoints), `eeb14420` (judge script)
**Bench:** the 47 never-captured key decisions of [2026-11-07 decision loss](./2026-11-07-decision-loss.md),
judged against their origin Sessions' Observations in main's checkpoint 040 (greedy
`eval:replay --llm-summary --decision-key` arm, synthetic compression)
**N:** 47 decisions from 17 Sessions (31 from AskUserQuestion answers, 16 from typed prompts)
**LLM:** local broker, decision judge from `eval/runner/decision-judge.ts`; 161 judge calls, 18 min at concurrency 8
**Embeddings:** not used (BM25 only)
**Hardware:** not reported; the bench is LLM-bound and measures presence, not latency

## Headline

The summarizer, not capture, loses these decisions. 44 of the 47 key decisions that no fresh
Summary held are stated in their origin Session's Observations, and 42 are stated in the
exact text the summarizer is given. Every decision's source input (the typed prompt or the
AskUserQuestion answer it was extracted from) has an Observation. The next lever is the
summarize prompt, not observe or compression.

## Presence in Observations

| Where the decision is | typed | ask | Decisions |
|---|---|---|---|
| its source Observation (prompt, or AskUserQuestion answer) | 12 | 28 | **40** |
| only elsewhere in the Session's BM25 top 10 | 2 | 2 | 4 |
| judged absent | 2 | 1 | 3 |
| **total** | 16 | 31 | 47 |

| Check | Decisions |
|---|---|
| source input has an Observation | 47 |
| source Observation in the decision's BM25 top 10 | 42 (35 at rank 1) |
| present in the summarizer's view (`renderSummaryObservation`) of the source or top 10 | 42 |
| present only in stored fields the summarizer is not shown | 2 |

Split of the 38 decisions the top 10 delivers: tool Observations alone 27 (AskUserQuestion
answers are tool Observations), prompt Observations alone 3, both 5, only the two together 3.

## Methodology

- Observations: `mem:obs:<session>` in checkpoint 040, opened read-only; every Session is in it.
  All are synthetic (`--llm-summary` leaves compression synthetic): a prompt Observation keeps
  the full `userPrompt` and a 2,000-char middle-out `narrative`; an AskUserQuestion Observation
  (type `decision`) keeps its questions and the `answers` map as JSON in the `narrative`.
- Source input: the decision id's input index into `operatorInputs()` of the transcript; a typed
  turn is matched to the prompt Observation whose `userPrompt` starts with it, an ask to the
  AskUserQuestion Observation holding its first question.
- Ranking: a per-Session `SearchIndex` (the daemon's BM25), queried with the decision text, top 10.
- Judging: `createJudge` per decision on (1) the summarizer's rendering of the top 10, (2) their
  stored text (title, narrative, full prompt, tool input, reply), (3) and (4) the same two for the
  source Observation alone, then the top 10's prompt and tool Observations apart. Present means
  (2) or (4). The judge cuts input at 20,000 chars; 4 top-10 renderings were longer.
- A hand check of the 3 judged absent found two arguably present (one stated as a question in
  the prompt, one a free-text answer naming the option) and one whose matched ask records the
  opposite answer; none changes the reading.

## Reproduce

The judge script is a session-folder scratch script, not in the repo:

```sh
npx tsx <session>/cand1/cand1.ts <session>/capture-split.ndjson <arm>/checkpoints/040-*.sqlite tmp/eval-replay/decision-key.json <out.ndjson>
```

## Notes

- AskUserQuestion answers are 31 of the 47, matching their share of the whole key (205 of 316
  decisions), so the summarizer is not specifically blind to them.
- The source Observation ranks first in 35 of the 47 searches for its own decision, so a
  per-turn extraction would find these inputs without search.
