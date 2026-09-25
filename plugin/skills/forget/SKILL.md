---
name: forget
description: Delete specific observations from agentmemory after showing them and getting explicit confirmation. Use when the user says "forget this", "delete memory", "remove that note", or wants to scrub specific data for privacy.
argument-hint: "[what to forget - session ID, file path, or search term]"
user-invocable: true
---

The user wants to remove data from agentmemory: $ARGUMENTS

## Quick start

```json
memory_smart_search { "query": "old api key in config", "limit": 20 }
```

Show the matches, get a yes, then:

```json
memory_forget { "memoryId": "abc12345" }
```

Expected output:

```text
Found 1 matching memory. Confirmed. Deleted 1 memory.
```

`memory_forget` removes one memory, or named observations inside one session.
`memory_governance_delete` takes several memory ids at once with a `reason`.
Both de-index, release any image the record held, and write an audit entry.

## Why

This is destructive and irreversible. Show exactly what will be deleted and get
an explicit yes before calling delete. Name the ids you are removing; a bare
`sessionId` takes the whole session and is almost never what was asked for.

## Workflow

1. Search with `memory_smart_search`, the user's text as `query`, `limit: 20`.
2. Show what matched: session ids, memory ids, titles. Ask for explicit
   confirmation. Do not proceed on silence or a vague "sure, whatever".
3. On confirmation, call `memory_forget` with `memoryId` for a single memory, or
   with `sessionId` plus comma-separated `observationIds` for observations —
   the layer recall actually surfaces. For several memories at once, use
   `memory_governance_delete` with `memoryIds` and optional `reason` (default
   `plugin skill request`).
4. To drop a whole session, its observations and its summary, call
   `memory_forget` with `sessionId` alone. Only do this when the user asked for
   the whole session; otherwise name the ids.
5. Lessons are separate: delete one with `memory_lesson_delete` and its
   `lessonId`; neither delete tool touches lessons.
6. Report the deletion count back. A count of 0 means the ids did not exist;
   say so instead of claiming a delete. `memory_governance_delete` lists the ids
   it skipped in `notFound`; those are usually observation ids, so retry them
   with `memory_forget` and their `sessionId`.

## Anti-patterns

WRONG: search returns matches, you immediately call `memory_governance_delete`
without showing them or waiting for a yes.

RIGHT: list the matches, ask "Delete these 2? (yes/no)", and only delete after
an explicit yes.

## Checklist

- Matches were shown to the user before any delete.
- An explicit yes was received, not assumed.
- The ids passed are real ones from the search, and a bare `sessionId` was
  used only when the whole session was what the user asked to drop.
- Final message states the actual count deleted.

## See also

- `remember`: the write side; forget is its undo.
- `recall`: find the exact memory id before deleting.

## Troubleshooting

See ../_shared/TROUBLESHOOTING.md if `memory_smart_search`, `memory_forget` or `memory_governance_delete` is not available.
