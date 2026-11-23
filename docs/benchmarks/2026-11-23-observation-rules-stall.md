# Stalled Observation redaction rules reads

**Decision (#523):** Keep fail-closed capture unchanged. Revisit a read deadline if a stalled rules-file read occurs in an Operator deployment or deployment evidence shows recurring exposure.

**Evidence:** An injected stall held callers sharing a rules read at the 1,100 ms observation cutoff. Releasing the read let queued captures store in order. No real filesystem stall was reproduced. The focused redaction admission and retry suites passed 31 tests across two files.

**Deployment scope:** The rules setting was absent from the inspected daemon's initial environment and current environment file; the inspected configuration directory was on local ext4. This does not establish the behavior of other deployments or of a separately configured rules path.

**Tradeoff:** A stalled read can leave captures waiting indefinitely. A deadline could bound that wait but must keep capture fail-closed, preserve ordered recovery of queued captures, isolate late completions from newer reads, and leave Recall available. The current tests do not verify those properties for a deadline implementation.
