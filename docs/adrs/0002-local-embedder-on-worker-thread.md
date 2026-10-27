---
type: Architecture Decision Record
title: Run the Local Embedder on a Worker Thread
description: The local embedding provider's model runs on a worker thread so inference never holds the daemon's event loop.
scope: [global]
tags: [runtime, embeddings, latency]
generated: { by: "agent/claude-opus-5-5", at: "2026-10-27T00:00:00Z" }
superseded_by:
status: proposed
---

# Run the Local Embedder on a Worker Thread

## Decision

The local embedding provider (`src/providers/embedding/local.ts`) loads and runs its model on a
`node:worker_threads` worker. Every embed call (Observation and Memory saves, query embeds, the
vector fill pass) posts its texts to that worker and awaits the vectors, so inference never runs
on the daemon's event loop. The daemon stays one process on one in-process Engine
([ADR 0001](./0001-single-in-process-sqlite-engine.md)): the worker holds no state and never
touches SQLite. Remote embedding providers are unaffected; they already wait on the network.

## Context

onnxruntime-node 1.30 runs inference synchronously on the calling JS thread; the `setImmediate`
around it only delays the block. Measured on a copy of the Operator's store (81,419 embed jobs,
local MiniLM), a boot re-embed after a vector-space change took about 85 minutes, and the event
loop was blocked for 99.7% of it. Each 32-text batch froze the daemon for 0.4–9.5 s, and 85% of
`readyz` polls took longer than the hooks' 1,500 ms Injection timeout. Every Missed Injection in
that window breaks the goal that memory is never on the critical path. A vector-space change
follows any embedding model switch, and the Operator runs the local embedder.

## Alternatives Considered

- **Smaller fill batches with a yield between them.** Each freeze shrinks to a few hundred
  milliseconds but does not go away, the re-embed takes longer, and save and query embeds still
  block. Revisit only if onnxruntime-node gains a truly asynchronous `run`.
- **A separate embedding process or service.** It would also unblock the loop, but adds a runtime
  to install, supervise and version, which ADR 0001 removed.

## Consequences

- Hooks get answers during a full re-embed; the fill pass's duration is unchanged.
- Each embed call pays a message hop to the worker and a copy of its vectors back.
- The model is loaded in the worker rather than the main thread, so a worker crash must be
  surfaced as a failed embed and the worker restarted on the next call; the fill pass already
  retries failed rows hourly.
