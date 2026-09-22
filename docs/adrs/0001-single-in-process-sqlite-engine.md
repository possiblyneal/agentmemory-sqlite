---
type: Architecture Decision Record
title: Run Only the In-Process SQLite Engine and Delete the iii-engine Path
description: This fork drops the iii-engine child-process runtime entirely and keeps the in-process node:sqlite engine as its only engine.
scope: [global]
tags: [runtime, persistence, fork-divergence]
generated: { by: "agent/claude-opus-5", at: "2026-09-19T00:00:00Z" }
superseded_by:
status: accepted
---

# Run Only the In-Process SQLite Engine and Delete the iii-engine Path

## Decision

This fork keeps exactly one engine: the in-process `node:sqlite` runtime introduced in
`96a6f5e`. The iii-engine child-process path — the WebSocket SDK on port 49134, the
`AGENTMEMORY_ENGINE` selector that chooses between them, and the modules only that path
reaches (notably sharded index persistence and the payload frame guard) — is removed rather
than maintained in parallel.

This decision covers the fork (`possiblyneal/agentmemory-sqlite`) only. It says nothing
about upstream `rohitg00/agentmemory`, which keeps both paths; fixes made here are no
longer portable upstream without rework.

## Context

`96a6f5e` ported an in-process SQLite runtime alongside the existing iii-engine path,
leaving engine selection behind `AGENTMEMORY_ENGINE=inproc`. The only deployment this fork
serves runs with that flag set, so the iii path is already dead code here.

Six bug reports filed upstream were being assessed for repair in this fork. Two of them —
the index-serialisation string ceiling and the orphaned index shards — exist *only* on the
iii path. Fixing them would mean writing and testing code for a runtime nobody here runs;
leaving them would mean shipping a branch known to be broken. Deleting the branch resolves
both without the dishonesty of either.

The parallel-engine structure also costs on every unrelated change: two persistence stories,
two failure modes, and conditionals like the boot rebuild gate that must be reasoned about
twice.

## Alternatives Considered

**Leave the iii path in place and fix nothing on it.** Zero work now, but it rots silently:
each later change is written against one engine and untested on the other, so the fallback
degrades into a trap for anyone who unsets the flag. Rejected because an unmaintained
fallback is worse than no fallback — it advertises a safety net that will not hold.

**Fix both paths.** Roughly double the work and double the test surface, spent on a runtime
this fork does not execute. Rejected on cost against zero realised benefit.

## Consequences

- No fallback. A defect in the in-process engine cannot be worked around by switching
  runtimes; it has to be fixed.
- The upstream issues filed from this fork lose their reference implementation here. Any
  patch offered back to `rohitg00/agentmemory` must be re-derived against the two-engine
  code, not cherry-picked.
- Sharded index persistence disappears with the iii path, and nothing is lost by it: the
  in-process engine already stores embeddings in its own `vectors` table and rebuilds the
  keyword index from stored content at boot. No embedding is recomputed because of this
  removal. The shards written by earlier iii-path runs become permanently dead bytes.
- `AGENTMEMORY_ENGINE` no longer selects anything. Nothing reads it, and nothing rejects
  it either, so an environment file that still sets it keeps loading untouched.
- `iii-sdk` stops being a dependency, and the code drops a layer of indirection — function
  registration and `trigger()` become direct in-process calls.
- Documentation describing agentmemory as built on iii-engine's three primitives becomes
  false for this fork and must be rewritten, not annotated.
- Code that budgeted time against iii's 180s invocation timeout is now bounding itself
  against a limit that no longer exists. `fetchWithTimeout`'s 170s `HARD_BUDGET_CAP_MS` was
  one such residual: it clamped every configured LLM timeout above it while the error still
  reported the unclamped value, so a slow local model looked like a provider failure. Treat
  any remaining iii-derived ceiling as a defect, not a safety margin.
