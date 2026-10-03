# Backlog

Work the Operator has accepted but not yet scheduled. An item moves to a GitHub issue on
`possiblyneal/agentmemory-sqlite` when work starts, and is deleted from here when it lands.

## Identify a model fit for LLM Observation compression

`AGENTMEMORY_AUTO_COMPRESS` stays off because the broker's `general` model is too slow to
compress every Observation. Find a model that can keep up with it, then turn it on.

- **Why it matters.** Synthetic compression (`src/functions/compress-synthetic.ts`) writes
  `concepts: []`, `facts: []` and `importance: 5` on every Observation. As a result:
  - consolidation never forms a concept group, so no Memories are made;
  - session-start context and eviction rank Observations on a tie;
  - the profile's importance-≥7 activity list is always empty.
- **Evidence (2026-09-27).** `general` on the broker at `10.10.10.13:4010` took 30–165s to
  first token per `graph-extract` batch, with no scheduler wait and no 429s. The model is
  the bottleneck, not queueing. The volume to keep up with is roughly 500 Observations a
  day, one LLM call each.
- **Done when.** A model sustains that rate at `AGENTMEMORY_LLM_MAX_CONCURRENCY=2` without
  starving Session summaries or graph extraction, and its output parses under
  `src/prompts/compression.ts`.

## Keep a stale-Session recovery sweep from starving graph extraction

While eviction's stale-Session recovery runs, its Summarize chunks crowd out graph
extraction on the broker. Give background recovery a smaller share of LLM capacity than
work for live Sessions.

- **What exists.** `ResilientProvider` (`src/providers/resilient.ts`) already caps every
  generating call at one shared `AGENTMEMORY_LLM_MAX_CONCURRENCY` (2 on dev). The cap
  bounds how many calls run at once, not who gets them: a recovery sweep can hold both
  slots, and a graph batch sharing the GPU with a 50k-token Summarize chunk slows to under
  1 token/s.
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

## Rank session-start Observations by something that varies

`mem::context` keeps a Session's Observations with `importance >= 5`
(`src/functions/context.ts:262`). Synthetic compression writes `importance: 5` on every
Observation, so the filter keeps all of them and the top 5 are just the most recent.

- **Evidence (2026-10-02).** Every devex Observation has importance ≥5.
- **Done when.** The cut separates Observations under synthetic compression, or it is
  removed, and `npm run eval:gate` holds.

## Let a Memory be global on purpose

`memory-project-coverage` (`src/functions/diagnostics.ts:462`) counts every Memory without a
`project` as unscoped. A preference that is meant to apply everywhere, such as the tmux one,
keeps the warning on for good.

- **Done when.** A Memory can be marked global explicitly, and the check counts only Memories
  that have neither a project nor that mark.
