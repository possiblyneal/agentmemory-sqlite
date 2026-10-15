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
