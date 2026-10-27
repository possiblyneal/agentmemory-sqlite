# Backlog

Work the Operator has accepted but not yet scheduled. An item moves to a GitHub issue on
`possiblyneal/agentmemory-sqlite` when work starts, and is deleted from here when it lands.

## Reproduce the daemon stalling under concurrent Sessions (rohitg00/agentmemory#499)

Upstream reports the server going unresponsive with several Claude Code Sessions open. It
never found a cause on its iii engine, and nothing here reproduces a hang.

- **What exists.** Context-injecting hooks are bounded by `AbortSignal.timeout` and record
  a Missed Injection on timeout (`src/hooks/_missed-injection.ts`); `/diagnostics`
  (`injections`) reports them.
- **Evidence (2026-10-05).** The live `missed-injections.jsonl` shows prompt-submit
  timeouts under concurrent Sessions: 768 on 2026-10-01, 79 on 2026-10-04. There was no hang.
- **Done when.** A load test with N concurrent Sessions either reproduces a stall (then it
  becomes an issue with the cause) or shows Missed Injections stay rare, and the triage row
  is closed either way.

## Reproduce the viewer disconnecting while the daemon stays healthy (rohitg00/agentmemory#1370)

Upstream reports the web UI randomly disconnecting until a page reload. The report has no
repro, and upstream's fix targets the iii stream join this tree does not carry.

- **What exists.** The viewer reconnects with backoff, falls back to polling and re-probes
  the stream (`src/viewer/index.html`).
- **Done when.** A disconnect is reproduced against the in-process stream server and fixed,
  or a soak test (viewer open for hours under live capture) shows none, and the triage row
  is closed either way.

## Measure whether commit, PR and issue text adds Recall value

The GitHub connector (sync issues and PRs as Observations) is built only if a measurement shows
the text earns its storage. Commit text goes into the same measurement, because today it does not
reach Recall either.

- **What exists.** `POST /agentmemory/commits` stores a `CommitLink` (sha, message, files,
  `sessionIds`) in `mem:commits` (`src/types.ts:21`, `src/triggers/api.ts:925-963`). It is
  looked up by sha and never indexed for search, so Injection never returns commit text.
  `integrations/filesystem-watcher` shows the connector shape: it POSTs to
  `/agentmemory/observe`. `eval:replay` scores Right content, Right moment and Least record
  against an answer key derived from the Operator's transcripts (`eval/README.md`, Replay).
- **Experiment.** Extend `eval:replay` so it can also ingest each repository's commits (from
  `git log`) and PR and issue text (from `gh`) as Observations. Ingest each item when its
  timestamp falls before Session k, so no probe sees text written after it. Run all 8 arms
  (none, each source alone, each pair, all three) with LLM and embedding settings held fixed,
  on repositories with real PR and issue history.
- **Done when.** A dated `docs/benchmarks/` scorecard compares the 8 arms on key items
  delivered, used share of Injected items, Injection chars per used item and store bytes per
  used item. It names the arm to build: a connector for the sources that pay for themselves,
  or none. If commit text pays, it should be indexed through the existing commit-link path
  rather than through a new connector.

## Revisit the prompt-submit hook's 1.5 s Injection wait (due 2026-11-02)

The Operator kept `INJECT_TIMEOUT_MS` at 1500 ms (`src/hooks/_missed-injection.ts`) on
2026-10-19 and asked to revisit it two weeks later.

- **What exists.** The reranker gate (`ai.lan:9202`) takes about 870 ms per idle request and
  serves one at a time; its cap is 1000 ms. Under 30 parallel sdebench tasks Injections arrived
  1.7–5.2 s late and were lost. An internal 1300 ms budget (v13) scored worse than none
  (`docs/benchmarks/2026-10-18-sdebench.md`).
- **Done when.** Two weeks of the live `missed-injections.jsonl` (`/diagnostics` `injections`)
  show whether prompt-submit timeouts under normal use cost Injections, and the wait is either
  raised with that evidence or kept and this item deleted.

## Re-score Session Summary decisions as a Recall layer (#259)

Indexing Summary decisions for Recall was built in two variants and scored once with no
effect. That test could not decide it, so it waits for free broker time.

- **What exists.** Draft #298 (`feat/summary-decision-index`): A `a3576cf` indexes decisions
  as a BM25 layer, B `4215e7b` adds an `appliesWhen` line written at summarize time. The
  replay scorecard (`docs/benchmarks/2026-10-22-summary-decision-index.md`) shows control, A
  and B equal on every hit metric, but its corpus held 2 decision key items, both already
  found by search.
- **Experiment.** Rebase #298 onto main, run one `eval:replay --llm --save-checkpoints
  --keyed-only` save pass on build B (about 48 h on the broker, so only when #234's load
  allows), then probe control, A and B from the same checkpoints. Run #259's sdebench passes
  only if an arm beats the control.
- **Done when.** A dated scorecard on a corpus with more decision key items names a winning
  arm, which ships from #298, or rejects both, and #298 is closed with its branch.
