# agentmemory

Persistent memory for AI coding agents. An agent's work is captured as it happens, distilled
into durable records, and recalled into later sessions on the same machine.

## Language

### People

**Operator**:
The person who runs the memory daemon and lives with its behaviour — disk growth, restarts,
recall quality. In this fork the Operator and the sole Agent's user are the same person, so
Operator time is a user-experience cost, not an infrastructure one.
_Avoid_: user, admin, owner

**Agent**:
An AI coding assistant whose activity is being remembered. The Agent is a source of
Observations and a consumer of Recall, never a decision-maker about the store itself.

**Session**:
One continuous stretch of an Agent's work, bounded by a start and an end hook. The unit that
Observations are attributed to and that Recall is scoped by.

### What is stored

**Observation**:
A single raw thing that happened during a Session — a tool call, a prompt, a failure. The
atomic, append-only input to everything else.
_Avoid_: event, log entry

**Memory**:
A durable distilled record derived from Observations, intended to be recalled later. Memories
are content-addressed, so the same content captured twice is one Memory.
_Avoid_: note, fact, item

**Session Summary**:
The distilled account of one Session, produced from its Observations each time the Session
stops.
A Session Summary is current until an Observation arrives after it was written, and a
current one is reused rather than reproduced.
_Avoid_: session digest, recap

**Entity**:
A named thing the Agent worked with — a file, a symbol, a service, a concept — held as a node
in the graph.
_Avoid_: node, vertex, object

**Relation**:
A directed, typed link between two Entities, held as an edge in the graph.
_Avoid_: edge, link, association

**Provenance**:
The set of Observation and Memory identifiers recorded on an Entity or Relation to say where
it came from. Provenance is evidence of origin, not a complete history: it is capped, and the
cap is deliberate.
_Avoid_: sources, history, lineage, backlinks

**Graph Snapshot**:
A precomputed, bounded view of the busiest Entities and their Relations, kept so that reads do
not have to walk the whole graph. Derived and disposable — never the authority for anything it
contains.
_Avoid_: cache, summary, materialized view

### What happens to it

**Extraction**:
Turning a batch of Observations into Entities, Relations, and Memories. Extraction is
best-effort per batch: a batch that cannot be written is dropped, not partially applied.
_Avoid_: ingestion, parsing, distillation

**Recall**:
Retrieving Memories relevant to an Agent's current work and returning them for injection into
its context.
_Avoid_: search, query, lookup, retrieval

**Eviction**:
Deliberately removing Memories that have aged out or lost relevance, under a policy. Distinct
from Reclaim.

**Reclaim**:
Deleting stored bytes that no longer back any live concept — data left behind by a removed
feature or a superseded write. Reclaim never changes what can be recalled; if it does, it was
Eviction and was a mistake.
_Avoid_: cleanup, garbage collection, vacuum, pruning

### Runtime

**Engine**:
The runtime that owns the SQLite store and dispatches work. This fork has exactly one — the
in-process engine — by [ADR 0001](./docs/adrs/0001-single-in-process-sqlite-engine.md).

**Health Verdict**:
The daemon's own judgement of its condition, one of *healthy*, *degraded*, or *critical*. A
Verdict is a sustained reading, not an instantaneous one: it changes only after consecutive
samples agree, because an external supervisor may restart the daemon on it.
_Avoid_: status, state, health check

**Sample Verdict**:
What a single reading says on its own, before the Health Verdict has had a chance to move.
Alerts describe the Sample Verdict, so the two legitimately disagree while a run of samples
accumulates. It is shown to an Operator so a lagging Verdict is not mistaken for a bug, and
is never a restart signal — only the Health Verdict is.
_Avoid_: instantaneous status, raw health, current health
