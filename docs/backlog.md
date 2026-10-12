# Backlog

Work the Operator has accepted but not yet scheduled. An item moves to a GitHub issue on
`possiblyneal/agentmemory-sqlite` when work starts, and is deleted from here when it lands.

## Publish a replay scorecard with the Injection Gate on

The 2026-10-07 coding-life scorecard measures the gate on synthetic questions only. Issue #169
also asked for `eval:replay` aggregates with the gate on.

- **What exists.** A cap-8 replay with LLM compression and the gate on (`possiblyneal/replay-fair`,
  unmerged) ran on 2026-10-08, but its subset holds no answer-key items and it changes LLM and
  gate together, so it cannot attribute the change.
- **Done when.** A dated `docs/benchmarks/` replay scorecard compares gate off vs on on an
  answer-keyed subset, with LLM settings held fixed.

## Finish moving slots to per-project scopes

#134 moved project slots into `mem:slots:project:<project>` (`KV.projectSlots`). Two pieces
were left for later.

- **Legacy rows.** Pre-upgrade project slots stay in the flat `mem:slots` scope
  (`KV.legacySlots`). Nothing injects them, and `memory_slot_list` shows the non-empty ones
  under `legacy` so the Operator can copy them into a project slot. After one release, a
  Reclaim deletes that scope and the `legacy` key goes away.
- **Slot scopes in snapshot, export/import and governance-delete.** None of them covers
  `mem:slots:global` or the per-project scopes. A per-project scope has no fixed name, so it
  can only be found with `kv.listScopes("mem:slots:project:")`. This picks up #127's
  follow-up that export and snapshot should carry slots once rohitg00/agentmemory#1108
  lands.
- **Done when.** `mem:slots` is gone and slot-list has no `legacy` key, and a snapshot,
  export or governance-delete covers the global slot scope and every project slot scope it
  enumerates.

## Retry only the reduce when a merged Session Summary fails schema

On a chunked Session, a merged Session Summary that fails schema re-runs every chunk call
plus the reduce (`src/functions/summarize.ts`, the 2-attempt loop around
`produceSummaryXml`). Retry only the reduce step.

- **Done when.** A schema-rejected merged summary retries the reduce call alone, and the
  chunked-path test in `test/summarize.test.ts` asserts 3 chunk calls + 2 reduce calls.

## Remove the TEAM_MODE=private setting that filters nothing

`loadTeamConfig` (`src/config.ts:311`) defaults `TEAM_MODE` to `private`, but team-feed and
team-profile (`src/functions/team.ts`) return the same items in either mode. One Operator
runs the daemon, so per-user privacy has no reader (`rohitg00/agentmemory#689` is wont-fix).

- **Done when.** `TEAM_MODE` and its `private`/`shared` branch are gone, or documented as a
  no-op, and no doc promises private team items.

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
