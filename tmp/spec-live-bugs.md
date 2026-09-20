## Problem Statement

The Operator runs a single agentmemory daemon on the in-process SQLite Engine. Four defects reported upstream are live for that deployment, and a fifth condition — a whole Engine that is never executed — is what makes two of them unfixable-in-place.

- The daemon's Health Verdict flips on a single 30-second sample. One transient spike is enough to publish `critical`, which an external supervisor reads as a restart signal. None of the thresholds behind that Verdict can be changed without editing source.
- Provenance on Entities and Relations grows without any bound. Every mention of an Entity appends another Observation id to a set that is only ever unioned, never trimmed, and the Operator pays for that growth in disk and in every read that touches those rows.
- When the Graph Snapshot cannot be read, Extraction silently treats the graph as empty, then writes that empty view back over the stored Snapshot — losing the real one and zeroing its counts, without even flagging the result as suspect.
- Index shards written by the unused Engine sit on disk with nothing able to read them.

The Operator asked for the live ones fixed. Two further reported defects are not live and are addressed by scope, not by code.

## Solution

Collapse to one Engine, then fix what remains.

The iii-engine child-process runtime is deleted from this fork, along with the sharded index persistence that only it reaches. Nothing the Operator uses depends on either: embeddings already persist in the in-process Engine's own vector table, and the keyword index is rebuilt from stored content at boot. The two defects that live only on that branch stop existing rather than being repaired. This is recorded in ADR 0001.

With one Engine, the rest are direct:

- A Health Verdict changes only after three consecutive samples agree, in both directions — roughly ninety seconds of sustained trouble before a restart is signalled, and the same before recovery is declared. Every threshold, and both hysteresis counts, become configurable from the environment.
- Provenance is capped at the fifty most recent ids, at every site that writes it. Rows already over the cap are trimmed once, at startup, so the store lands under the line in a single pass instead of waiting for each row to be mentioned again.
- A Snapshot read failure aborts that batch of Extraction before anything is written. The stored Snapshot survives; the batch is lost and retried next Session.
- The Snapshot stops carrying Provenance at all. Anything wanting origin reads the Entity or Relation itself.
- The dead index shards are deleted once, at startup.

## User Stories

1. As an Operator, I want a single Engine in this fork, so that every line of code I maintain is a line that actually runs.
2. As an Operator, I want the unused Engine deleted rather than left to rot, so that I am not misled by a fallback that would not work if I reached for it.
3. As an Operator, I want `AGENTMEMORY_ENGINE` to keep being accepted after the removal, so that my existing environment file continues to work without edits.
4. As an Operator, I want the removal to recompute no embeddings, so that deleting a persistence layer costs me nothing at the next boot.
5. As an Operator, I want a Health Verdict that reflects sustained condition, so that one slow garbage collection does not restart my daemon.
6. As an Operator, I want the same patience applied to recovery, so that a daemon does not oscillate between restarting and being declared well.
7. As an Operator, I want every health threshold settable from the environment, so that I can tune the daemon for my machine without a rebuild.
8. As an Operator, I want the hysteresis counts themselves settable, so that I can make the daemon twitchier or calmer without patching it.
9. As an Operator, I want defaults that preserve today's numeric thresholds, so that configurability does not silently change behaviour.
10. As an Operator, I want a Verdict that has not yet reached its threshold to leave the published Verdict unchanged, so that a probe never sees a half-formed judgement.
11. As an Operator, I want the daemon's first samples after startup to reach a Verdict promptly, so that hysteresis does not leave the daemon unjudged for minutes.
12. As an Operator, I want Provenance capped, so that Entity rows stop growing in proportion to how often the Agent mentions them.
13. As an Operator, I want the cap applied to Relations as well as Entities, so that the edge side does not absorb the growth the node side just shed.
14. As an Operator, I want the cap applied at Entity and Relation creation, not just at merge, so that a single large Extraction batch cannot write an oversized row in the first place.
15. As an Operator, I want the cap applied to the temporal Extraction path too, so that a second write site does not quietly reintroduce unbounded growth.
16. As an Operator, I want the cap to keep the most recent ids, so that what survives is the evidence closest to current work.
17. As an Operator, I want rows already over the cap trimmed once at startup, so that a store that is already bloated recovers without waiting for each row to be touched again.
18. As an Operator, I want that startup trim to run once and know it has run, so that every subsequent boot does not rescan the whole graph.
19. As an Operator, I want the cap's value settable from the environment, so that I can keep more evidence on a machine with disk to spare.
20. As an Agent, I want Provenance to remain present and meaningful after capping, so that I can still trace a recalled Entity back to work that produced it.
21. As an Operator, I want a failed Snapshot read to abort Extraction before any write, so that a transient fault cannot destroy the stored Snapshot.
22. As an Operator, I want that abort surfaced in the log at warning level, so that I find out it happened rather than inferring it from missing data.
23. As an Operator, I want the aborted batch to be retried in a later Session rather than retried in place, so that a persistent read fault does not spin.
24. As an Operator, I want the stored Snapshot's counts left alone when a batch aborts, so that its statistics never reflect a graph that was never read.
25. As an Operator, I want the Snapshot to stop carrying Provenance, so that it stays small and stops growing with how often Entities are mentioned.
26. As an Agent, I want Provenance still reachable from the Entity and Relation records after it leaves the Snapshot, so that dropping it from one place does not remove it from the system.
27. As an Operator, I want dead index shards deleted at startup, so that space comes back without my intervention.
28. As an Operator, I want that deletion to touch only shard data, so that nothing recallable is ever at risk from it.
29. As an Operator, I want the shard deletion to be idempotent and quiet once there is nothing left, so that it costs nothing on every boot after the first.
30. As an Operator, I want both startup sweeps to run as one pass, so that boot does not walk the store twice.
31. As an Operator, I want both startup sweeps to report what they did, so that I can confirm the recovery actually happened.
32. As an Operator, I want neither startup sweep to block readiness, so that a large one-time cleanup does not look like a failed start.
33. As an Operator, I want the dimension-mismatch defect left unfixed here and left open upstream, so that scope stays honest about what this work covers.
34. As an Operator, I want the documentation that describes this project as built on iii-engine rewritten rather than annotated, so that a future reader is not told something false about this fork.
35. As an Operator, I want the test suite to pass with the deleted modules' tests removed rather than skipped, so that the suite reflects the code that exists.

## Implementation Decisions

**Engine removal.** The iii-engine runtime, the Engine selector, the sharded index persistence module, and the payload frame guard are deleted. The `iii-sdk` dependency goes with them; function registration and dispatch become direct in-process calls. The `AGENTMEMORY_ENGINE` environment variable is read and ignored rather than rejected, so existing environment files continue to load. Recorded in `docs/adrs/0001-single-in-process-sqlite-engine.md`.

**Health Verdict.** Verdict evaluation stays a pure function. Hysteresis is folded into it rather than layered on top: the function takes the current sample plus the prior Verdict and the run of consecutive disagreeing samples, and returns the new Verdict along with the updated run. The published Verdict changes only when the run reaches the configured count, in either direction. The monitor holds that state in its own closure; it is deliberately not persisted, because a restart legitimately resets the judgement.

All threshold values and both hysteresis counts move into the same configuration object the evaluator already accepts, each with an environment override under a common prefix. Defaults reproduce today's numbers exactly. A snapshot missing a field continues to mean "no signal from that dimension" rather than a failing one.

**Provenance cap.** A single named bound, default fifty, overridable from the environment. It is applied at every site that writes Provenance: both merge helpers in the graph module, both Entity and Relation creation writes, and the separate union in the temporal Extraction path. Ids are appended in chronological order, so the cap is a tail slice — the newest survive.

**Startup maintenance.** One pass, invoked after the store is open and before readiness is declared but not blocking it, performing two independent jobs: trimming over-cap Provenance rows, and deleting the dead index shard scopes. It records that it has completed so later boots skip the scan. It is exposed as a single function taking the open store, which is the seam it is tested at.

**Snapshot.** The read helper stops swallowing failures into an empty result. A failure propagates far enough for the Extraction batch to abort before its first write; the stored Snapshot is untouched and the failure is logged at warning level. The Snapshot projection drops Provenance from both the Entity and Relation shapes it carries; the underlying records keep theirs.

## Testing Decisions

A good test here asserts what the Operator would observe — a Verdict, a row's contents, whether a write happened — never how the code arrived there. Three seams, all of them already in use:

**Verdict evaluation.** The existing pure-function seam, already exercised by `test/health-thresholds.test.ts`, which covers the memory-severity cases in exactly this style. Extend it with sequences of samples rather than single samples: a spike that never reaches the count must not change the published Verdict; sustained trouble must change it on the nth sample and not before; the same in reverse for recovery; configured counts of one must behave as no hysteresis at all.

**Graph writes.** The existing seam in `test/graph.test.ts`, which registers the graph function against mock store helpers and drives it end to end. Covers the cap at all write sites including the temporal path, that the newest ids are the survivors, that a Snapshot read failure aborts before any write and leaves the stored Snapshot intact, and that the projected Snapshot carries no Provenance while the records still do.

**Startup maintenance.** A new file, driving the single maintenance entry point against an in-memory SQLite store seeded with over-cap rows and dead shard scopes. Asserts the trim brings rows to the cap keeping the newest, that shard scopes are gone and nothing else is, that a second run is a no-op, and that recallable data is untouched.

Tests for the deleted modules are deleted, not skipped. One existing assertion encodes current behaviour that this work changes and must be updated rather than worked around: `test/index-persistence.test.ts` goes entirely with its module.

## Out of Scope

- **Embedding dimension inference.** The Operator's environment already sets an explicit dimension, so the wrong-guess default cannot fire for them. It remains a real defect and remains open upstream.
- **The index serialisation ceiling.** It exists only on the deleted Engine.
- **A size ceiling on store writes.** It was proposed to guard a frame limit that the in-process Engine does not have.
- **Retroactive repair of anything other than over-cap Provenance and dead shards.** The startup pass is not a general migration.
- **Upstream portability.** These fixes assume one Engine and will not apply cleanly to the two-Engine code.
- **Any change to Recall ranking, Eviction policy, or the MCP surface.**

## Further Notes

The upstream reports behind this work are rohitg00/agentmemory #1223, #1168, #1127, #1115, plus #1373 and #1372 which this spec places out of scope. None are fixed upstream.

A measurement of the live store — row counts, Provenance length distribution, shard bytes — was requested and had not returned when this spec was written. It affects none of the decisions above, only the expected magnitude of the one-time startup recovery.

Glossary terms used here are defined in `CONTEXT.md`.
