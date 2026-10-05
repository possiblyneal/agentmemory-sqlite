# Backlog

Work the Operator has accepted but not yet scheduled. An item moves to a GitHub issue on
`possiblyneal/agentmemory-sqlite` when work starts, and is deleted from here when it lands.

## Keep a stale-Session recovery sweep from starving graph extraction

While eviction's stale-Session recovery runs, its Summarize chunks crowd out graph
extraction on the broker. Give background recovery a smaller share of LLM capacity than
work for live Sessions.

- **What exists.** `ResilientProvider` (`src/providers/resilient.ts`) already caps every
  generating call at one shared `AGENTMEMORY_LLM_MAX_CONCURRENCY` (2 on dev). The cap
  bounds how many calls run at once, not who gets them: a recovery sweep can hold both
  slots. Summarize chunk and merge prompts are capped at `SUMMARIZE_CHUNK_TOKENS` (16k
  default), which shortens each prefill but does not limit how many slots recovery holds.
- **Evidence (2026-09-28).** A graph batch sharing the GPU with a 50k-token Summarize chunk
  (the default then) slowed to under 1 token/s. During the recovery sweep of 43 stale
  Sessions, the broker mostly served ~50k-token prompts (2 chunks at a time). A
  10-Observation graph batch timed out at 300 s at 16:46, while one slot was generating
  6.6k tokens and another was prefilling a 45k-token prompt.
- **Done when.** A recovery sweep leaves at least one slot for Session-stop work (Summarize
  and graph extraction), for example by capping background callers at one slot, and no
  graph batch times out during a sweep.

## Cap the crystallize and procedural-extraction prompts

Reflect's cluster prompt now fits a 24k-character budget (`src/functions/reflect.ts`). Two
other consolidation calls still send whatever their inputs add up to.

- **What exists.** `mem::crystallize` (`src/functions/crystallize.ts:54-57`) joins every
  action in a group into one prompt, and auto-crystallize groups all done actions of a
  project on every Stop (`src/triggers/events.ts:180`). Procedural extraction
  (`src/functions/consolidation-pipeline.ts:207-222`) sends every `pattern` Memory seen in
  2+ Sessions.
- **Evidence (2026-10-01).** On dev, `mem:actions` holds 1 action and `mem:crystals` none,
  and procedural extraction had too few patterns to run, so neither has sent a large
  prompt yet.
- **Done when.** Both prompts are bounded the way reflect's is, before either input grows
  enough to starve sibling slots on the broker.

## Lock replay's Session write

JSONL replay reads a Session, edits `observationCount` and the rest of the record, and writes
it back whole with `kv.set` (`src/functions/replay.ts:427-452`) without taking `obs:${id}`, the
key every other Session writer holds. A replay running against a live Session can drop an
observe's count or a commit-link's `commitShas`.

- **Done when.** Replay's read-modify-write of `mem:sessions` holds `obs:${id}`.

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
