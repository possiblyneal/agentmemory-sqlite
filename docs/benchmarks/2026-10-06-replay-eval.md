# 2026-10-06 — replay eval

**Commit:** `f5c13ed` plus the replay runner (this PR)
**Bench:** replay of the Operator's own Claude Code transcripts (`npm run eval:replay`; private data, aggregates only)
**N:** 84 Sessions in 3 projects (A: 37, B: 27, C: 20), 776 probed prompts, 93 answer-key items (90 files, 1 repeated correction, 2 revisited decisions)
**K:** 5 for the `smart-search` baseline; a prompt-context Injection is scored whole
**Hardware:** linux 6.12, 8 cores, node 22.23
**Embeddings:** on-device (local MiniLM), no reranker
**LLM:** none (Memories are synthetic; no summaries or Crystals)

## Headline

First measurement, so there is no control. Against the proxy answer key, the per-prompt Injection delivered 3 of 93 needed items in time (3.2%) and `smart-search` alone 2 of 93 (2.2%); either path reached 5 of 93 (5.4%). The manual audit says the key, not Recall, explains most of that gap: of the 20 worst proxy misses, 1 was a real miss (5%). Right scope and the critical path are clean (0 cross-project leaks, 0 probes over the 1.5 s hook timeout). Injection content is noisy: 11.3% of 1,861 injected items bore on the work that followed.

## Per Goal line

| Goal line | Measure | Value |
|---|---|---|
| Right content | injected items used by the Session | 211 / 1,861 (11.3%) |
| Right content | Injection chars per used item | 5,767 |
| Right moment | key items delivered in time, Injection | 3 / 93 (3.2%) |
| Right moment | key items delivered in time, search alone | 2 / 93 (2.2%) |
| Right moment | key items delivered in time, either | 5 / 93 (5.4%) |
| Right moment | by rule, either: file / correction / decision | 4 / 90, 1 / 1, 0 / 2 |
| Right scope | injected items from another project | 0 / 1,861 |
| Durable beats recent | repeated corrections injected before the repeat | 1 / 1 |
| Least record | store bytes per distinct used item | 862 KB (164.6 MB store, 191 distinct used items) |
| Never on the critical path | session-start p50 / p99 | 71 ms / 171 ms |
| Never on the critical path | prompt-context p50 / p99 | 36 ms / 238 ms |
| Never on the critical path | smart-search p50 / p99 | 158 ms / 299 ms |
| Never on the critical path | probes over 1.5 s | 0 of 1,636 |
| Operator attention | store growth per replayed week | 33.2 MB (4.96 weeks replayed) |

## Methodology

- Projects: the 3 busiest `~/.claude/projects` directories by main-Session count, anonymised A/B/C. Cap 40 Sessions per project, earliest first, after dropping Sessions with fewer than 2 human turns; B skipped 7 transcripts over 20 MB and C skipped 1. All 84 replayed Sessions were probed with no failed probe.
- Everything else is as in `eval/README.md` (Replay): one sandbox daemon, Sessions in global start order, probes before ingest, answer key from the Session's own transcript against earlier Sessions of the same project.
- Wall time 48.8 minutes, dominated by ingest.
- Audit: the 20 worst proxy misses (`worst-cases.md` order, most earlier Sessions first) were checked by reading the transcript around each turn.

## Reproduce

```sh
git checkout <this PR's commit>
npm ci && npm run build
npm run eval:replay -- --projects=<dir>,<dir>,<dir> --cap 40
```

Needs your own `~/.claude/projects`; numbers will differ.

## Notes

- Audit of the 20 worst proxy misses: 1 real miss (5%) — a source file the prompt's topic plainly pointed at. The other 19 were key artifacts: 9 were `CLAUDE.md` files, which Claude Code loads on its own, so the Agent never needed Recall for them; 4 were turns that are automated teammate messages, not Operator prompts (two of them also produced the only "decisions"); 6 were terse replies ("y", a numbered pick) or a file unrelated to the prompt, where the need comes from earlier context in the Session that a per-prompt query cannot see. The 3.2% / 5.4% figures are therefore a floor on how much a corrected key would credit, not a measure of Recall quality.
- The key is thin outside files: 1 repeated correction and 2 decisions in 84 Sessions, so the correction and decision numbers carry no weight. Their detection rules are exact enough to avoid noise but miss paraphrases.
- 88.7% of injected items did not bear on the Session's later prompts or files. The Injections include "Base directory for this skill" and bulky tool-result observations, which cost 5.8k chars per used item. This is the clearest lead for Right content.
- The store grew to 164.6 MB over 84 Sessions (about 33 MB per replayed week), mostly raw observations; with no LLM there is no compression or consolidation to offset it.
- Timing is comfortably inside the hook timeout at every percentile measured; a slower embedder is not covered here.
- The runner warns when the daemon's injection record count is one short of the probe count (a probe that injected nothing writes no record); scoring is unaffected.
