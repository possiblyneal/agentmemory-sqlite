# 2026-11-13 — Session Summary decisions as a BM25 layer, re-scored on the decision key (#298, #398)

**Commit:** control `77fcdbba` (main), A `504201e4` (decision layer), B `d4f6f0f1` (A plus `appliesWhen`); A and B are PR #298
**Bench:** `eval:arm` save pass, then `eval:replay --from-checkpoints --decision-key` per arm, compared with `eval:compare`
**N:** 49 Sessions replayed and summarized, 29 probed (23 project directories, `--cap 40 --min-turns 2`), 261 prompt-context probes; 421 reachable decision items (316 decisions in the frozen key, sha256 `0746dc17…`), 0 unreachable
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** linux x86_64, 12 cores, Node v22.23.4; the three probes ran on separate instances (control 42, A 43, B 41)
**Embeddings:** on-device (replay default)
**LLM:** save pass only: the Operator's OpenAI-compatible broker, model `general-eval-b`, auto-compress off, concurrency 1; probes make no LLM call

## Headline

Neither variant delivers a decision the control did not. Decisions delivered by either surface: control 66,
A 66, B 66 of 421. Control against A and control against B are each 65 both, 1 control-only, 1 variant-only
(exact McNemar p = 1.00). Delivered by turn is 77 in every arm. A and B are identical on every Recall
metric, so the `appliesWhen` line changes nothing here either. Per the retest runbook a variant ships only
on a measured gain, so neither does and #298 is closed unmerged.

## Per arm

| Arm | Injected items | Used | Injection chars | Decisions either (of 421) | By turn | Session start | Prompt submit | Substantive needs hit (of 203) | Terse needs hit (of 84) |
|---|---|---|---|---|---|---|---|---|---|
| control | 463 | 46 | 413,691 | 66 | 77 | 46 | 25 | 71 | 4 |
| A | 464 | 46 | 414,117 | 66 | 77 | 46 | 25 | 69 | 4 |
| B | 464 | 46 | 414,117 | 66 | 77 | 46 | 25 | 69 | 4 |

Prompt submit by turn is 38 in each arm. Right scope: 0 leaks in every arm. Correction before repeat:
no repeated corrections in the corpus. Store size is 66,744,320 bytes in each arm.

The one regression is `turnOwn.substantive.needs.hit`, 71 to 69 of 203 (0.350 to 0.340), identical in A
and B. Both arms inject 1 more item and 426 more characters than the control: 1,092 more on terse prompts and
666 fewer on substantive ones.

## Critical path

The probes shared one host and ran on separate instances, so the latency rows are not attributable to
the layer.

| Arm | session-start p50 / p99 | prompt-context p50 / p99 | search p50 / p99 | search over hook timeout |
|---|---|---|---|---|
| control | 32.6 / 83.4 ms | 123.4 / 952.7 ms | 63.1 / 363.2 ms | 1 |
| A | 34.6 / 51.2 ms | 135.1 / 816.7 ms | 71.4 / 588.8 ms | 1 |
| B | 27.7 / 83.8 ms | 97.8 / 935.8 ms | 51.4 / 304.4 ms | 0 |

A and B run the same code on the read path (B adds only the write-side line), so their p50 gap of 37 ms
on prompt-context shows the spread between runs, not a cost of either layer.

## Methodology

- One save pass built the checkpoints with B's summarizer (`--llm-summary`), so all three arms read
  identical stores and differ only in the build that probes them. It summarized 49 Sessions in 562
  `mem::summarize` calls (521 counted by the function, 330 folds, 191 full, 90 reused), with 0 failed
  summarizes, in 63,551 s (1,059 minutes), and kept 29 checkpoints.
- The probe is the one that scored #259's 37 key items; here the decision key supplies 421 reachable
  decision items, so a decision effect can show. #259 had 2.
- The key is frozen (`tmp/eval-replay/decision-key.json`, reused, not rebuilt) and verdicts were cached
  across arms, so a judged item is the same item in all three.
- Dev split only; the holdout was not opened.
- The transcripts quote private work, so only the aggregates above are published.

## Reproduce

```sh
npm run eval:arm -- --ref d4f6f0f1 --label 298-B --instance 41 --root <corpus> --projects=<dirs> --cap 40 --min-turns 2 --llm-summary
npm run eval:replay -- <same corpus flags> --instance <42|43> --from-checkpoints <298-B save checkpoints> --decision-key --out tmp/arm-out/probe   # in each arm's tree
npm run eval:compare -- 298-control 298-A
```

## Notes

- #259 found the layer neutral on 2 decision items and called it inconclusive. With 421 reachable
  decision items the result is the same: no gain.
- Session start delivers 46 of the 66 decisions and prompt submit 25 (38 by turn); the layer moves 1 in and
  1 out. 355 decisions reach the Agent by neither surface, so the miss is not in ranking the Summary's
  decisions.
- The extra terse-prompt characters (39,752 to 40,844) buy no terse hit (4 of 84 in all three arms).
- Tags `arm-298a` and `arm-298b` keep the two commits after #298's branch is deleted.
