# 2026-10-06 — replay eval

**Commit:** `f5c13ed` plus the replay runner (this PR)
**Bench:** replay of the Operator's own Claude Code transcripts (`npm run eval:replay`; private data, aggregates only)
**N:** 83 Sessions in 3 repositories (A: 16, B: 40 of 65, C: 27), 593 probed prompts, 28 answer-key items (28 files, 0 repeated corrections, 0 revisited decisions)
**K:** 5 for the `smart-search` baseline; a prompt-context Injection is scored whole
**Hardware:** linux 6.12, 8 cores, node 22.23
**Embeddings:** on-device (local MiniLM), no reranker
**Injection:** `AGENTMEMORY_INJECT_CONTEXT=true`, as on the Operator's live daemon
**LLM:** none (Memories are synthetic; no summaries or Crystals)

## Headline

First measurement, so there is no control. Against the proxy answer key, the per-prompt and session-start Injections delivered 1 of 28 needed items in time (3.6%) and `smart-search` alone 4 of 28 (14.3%); either path reached 4 of 28. The manual audit says the key, not Recall, explains most of the gap: of the 20 worst proxy misses, 1 was a real miss (5%). Right scope and the critical path are clean (0 cross-project leaks, 0 probes over the 1.5 s hook timeout). Injection content is noisy: 6.1% of 2,550 injected items bore on the work that followed.

## Per Goal line

| Goal line | Measure | Value |
|---|---|---|
| Right content | injected items used by the Session | 156 / 2,550 (6.1%) |
| Right content | Injection chars per used item | 6,227 |
| Right moment | key items delivered in time, Injection | 1 / 28 (3.6%) |
| Right moment | key items delivered in time, search alone | 4 / 28 (14.3%) |
| Right moment | key items delivered in time, either | 4 / 28 (14.3%) |
| Right moment | by rule, either: file / correction / decision | 4 / 28, — / 0, — / 0 |
| Right scope | injected items from another project | 0 / 2,550 |
| Durable beats recent | repeated corrections injected before the repeat | none in the key |
| Least record | store bytes per distinct used item | 686 KB (94.0 MB store incl. WAL, 137 distinct used items) |
| Never on the critical path | session-start p50 / p99 | 69 ms / 154 ms |
| Never on the critical path | prompt-context p50 / p99 | 27 ms / 168 ms |
| Never on the critical path | smart-search p50 / p99 | 108 ms / 247 ms |
| Never on the critical path | probes over 1.5 s | 0 of 1,269 |
| Operator attention | store growth per replayed week | 19.1 MB (4.92 weeks replayed) |

## Methodology

- Repositories: the 3 busiest in `~/.claude/projects` by transcript count, each replayed whole (its main checkout plus every worktree directory, 41 directories in all), anonymised A/B/C. Scratch directories under `~/code/tmp` were not counted as repositories. Each Session is filed under its repository as the live hooks' `resolveProject()` files it, so worktrees of one repository recall each other.
- Cap 40 Sessions per repository, earliest first, after dropping Sessions with fewer than 2 human turns; C skipped 1 transcript over 20 MB. All 83 replayed Sessions were probed with no failed probe, and every Injection record matched its probe.
- Everything else is as in `eval/README.md` (Replay): one sandbox daemon, Sessions in global start order, probes before ingest, answer key from the Session's own transcript against earlier Sessions of the same repository.
- Wall time 25.7 minutes, dominated by ingest.
- Audit: the 20 worst proxy misses (`worst-cases.md` order, most earlier Sessions first) were checked by reading the transcript around each turn.

## Reproduce

```sh
git checkout <this PR's commit>
npm ci && npm run build
npm run eval:replay -- --projects=<every directory of each repository> --cap 40
```

Needs your own `~/.claude/projects`; numbers will differ.

## Notes

- Audit of the 20 worst proxy misses: 1 real miss (5%), an operations doc the Agent had to find before answering a status question about that system. The other 19 were key artifacts: 10 were terse replies or approvals ("go ahead", a numbered pick) whose need came from earlier in the same Session, which a per-prompt query cannot see; 6 were instruction files (`CLAUDE.md`, `CONTEXT.md`, `LESSONS.md`) the Agent reads by convention; 3 were skill expansions or a continuation summary, not Operator prompts. The 3.6% / 14.3% figures are therefore a floor on what a corrected key would credit, not a measure of Recall quality.
- The key is thin: 28 file items and no corrections or decisions in 83 Sessions, so only the file rule carries any weight. Excluding instruction files and non-Operator turns from the key would remove about half of the remaining misses.
- 93.9% of injected items did not bear on the Session's later prompts or files, at 6.2k Injection chars per used item. This is the clearest lead for Right content.
- The store grew to 94.0 MB over 83 Sessions (about 19 MB per replayed week), mostly raw observations; with no LLM there is no compression or consolidation to offset it.
- Timing is comfortably inside the hook timeout at every percentile measured; a slower embedder is not covered here.
