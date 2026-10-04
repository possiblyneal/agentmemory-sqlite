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
  slots, and a graph batch sharing the GPU with a 50k-token Summarize chunk slows to under
  1 token/s.
- **Partly addressed.** `SUMMARIZE_CHUNK_TOKENS` now defaults to 16k, so each prefill is
  shorter; recovery can still hold both slots.
- **Evidence (2026-09-28).** During the recovery sweep of 43 stale Sessions, the broker
  mostly served ~50k-token prompts (`SUMMARIZE_CHUNK_TOKENS`, 2 chunks at a time). A
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
