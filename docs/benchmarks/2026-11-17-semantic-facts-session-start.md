# 2026-11-17 — Semantic Facts at session start, on vs off (#421)

**Commit:** control `ef548d85`; off arm `9288af07` (`5f779312`, which drops the `## Semantic Facts` block from `mem::context`, on `ef548d85`)
**Bench:** decision-key replay (`eval:arm` save pass, probe from checkpoints, `eval:compare`) and coding-agent-life-v2
**N:** replay: 49 Sessions saved, 29 probed, 261 prompts, 421 reachable decision items of the frozen key; coding-life: session-start 2 (1 no-answer)
**K:** an Injection is scored whole
**Hardware:** Linux 6.12, 12 cores, Node 22.23.4
**Embeddings:** on-device (sandbox default)
**LLM:** save pass `--llm-summary --derived` through the shell's OpenAI-compatible provider (model not recorded in `run.json`); 521 of 521 summarize calls succeeded; probes make no LLM call besides the cached decision judge

## Headline

Dropping the Semantic Facts block from session start loses 4 decision items and gains none:
84 of 421 delivered by either surface with the block, 80 without (both 80, facts-only 4,
no-facts-only 0, McNemar p 0.125). The budget the block freed was not taken up by Summary
decisions: every probed Session rendered the same number of Summaries in both arms. The
hypothesis that removal keeps `decisionRecall` and frees budget for Summaries is rejected.

## Per path

Both arms probe the same 29 checkpoints (one save pass, 1,204 `mem:semantic`, 48 Summaries and
138 Insights in the last checkpoint); only the session-start render differs.

| Metric | Facts on | Facts off |
|---|---|---|
| decisionRecall either | 84 (0.200) | 80 (0.190) |
| decisionRecall session start | 66 | 64 |
| decisionRecall prompt submit | 19 | 17 |
| decisionRecall prompt submit by turn | 35 | 33 |
| injected items | 460 | 361 |
| used items | 51 | 51 |
| used share | 0.111 | 0.141 |
| injection chars | 396,916 | 389,003 |
| session-start p50 | 19 ms | 14 ms |

coding-agent-life-v2 scores identically in both arms (session-start recall 0.625, precision
1.000, 2,356 chars; prompt-submit recall 0.861): its corpus consolidates no Semantic Facts, so
it does not test the block.

## Methodology

`npm run eval:arm` built the control and ran its save pass and probe. The off arm reused that
save pass's checkpoints (`--from-checkpoints`) and ran only the probe with the off build, so the
stores are byte-identical and the comparison isolates the render. Dev split only.

## Reproduce

```sh
npm run eval:arm -- --ref ef548d85 --label facts --instance 43 --root <corpus> --projects=<dirs> --cap 40 --min-turns 2 --llm-summary --derived
# off arm: build 9288af07 in its own worktree, then
npm run eval:replay -- --from-checkpoints tmp/eval-arms/facts/out/save/checkpoints --decision-key --instance 43 --root <corpus> --projects=<dirs> --cap 40 --min-turns 2 --out <tree>/tmp/arm-out/probe
npm run eval:compare -- <facts probe> <off probe>
```

## Notes

- The 4 facts-only items (Sessions `5b2e2552` ×2 counting turns 1 and 5, `f3e72519`, `95e176be`) were
  all delivered at session start, in Injections that carried 5 Semantic Facts; Summary,
  Insight and Lesson items were the same in both arms.
- Two items in Session `d7c034c8` moved between surfaces: prompt submit delivered them with
  facts on, session start without. The either-surface count is unchanged.
- The 99 Semantic Fact items injected were never used by the Agent (used items 51 in both arms),
  so the block costs `rightContent` share while carrying decisions the judge credits.
- The live store holds 39,187 facts against 1,204 here; the Session sample is the frozen key's,
  not the live store's mix.
