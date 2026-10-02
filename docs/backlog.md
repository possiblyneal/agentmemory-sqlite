# Backlog

Work the Operator has accepted but not yet scheduled. An item moves to a GitHub issue on
`possiblyneal/agentmemory-sqlite` when work starts, and is deleted from here when it lands.

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

## Moved to issues

- Derive Observation type, importance and concepts — #90 (also covers ranking session-start Observations)
- Cap stale-Session recovery at one LLM slot — #91
- Merge the three env-file hydration loops — #92
- Put Session writers on one lock — #93
- Score Insights in the injection-use check — #94
- Let a Memory be global on purpose — #95
