# forget worked examples

## 1. Delete a leaked secret

User: "Forget that note where I pasted the API key."

Search:

```json
memory_smart_search { "query": "api key", "limit": 20 }
```

Response:

```json
{
  "results": [
    { "id": "abc12345", "sessionId": "7f3a9c21", "title": "Pasted staging API key",
      "narrative": "STAGING_KEY=sk-live-..." }
  ]
}
```

Present and gate:

> Found 1 match:
> - `abc12345` (session `7f3a9c2`) "Pasted staging API key"
>
> Delete this memory? (yes/no)

After the user says yes:

```json
memory_forget { "memoryId": "abc12345" }
```

Response:

```json
{ "deleted": 1 }
```

Present:

> Deleted 1 memory (`abc12345`).

## 2. Drop two observations, not the session

User: "Forget the two shell commands I ran in that debugging session, keep the rest."

```json
memory_smart_search { "query": "debugging shell commands", "limit": 20 }
```

Response has 2 results with `sessionId: c98f1100` and ids `o1`, `o2`. Show both,
get a yes, then name them:

```json
memory_forget { "sessionId": "c98f1100", "observationIds": "o1,o2" }
```

Response:

```json
{ "deleted": 2, "observationsDeleted": 2 }
```

## 3. Drop a whole session

User: "Delete everything from the throwaway spike session."

Only when the whole session is what was asked for:

```json
memory_forget { "sessionId": "c98f1100" }
```

This removes every observation in it plus the session and its summary. To remove
several memories instead, pass their ids together:

```json
memory_governance_delete {
  "memoryIds": ["m1", "m2", "m3", "m4"],
  "reason": "drop throwaway spike session"
}
```

## 4. User declines

User: "Actually, on second thought, keep them."

Do not call delete. Confirm:

> Understood, nothing deleted. The 4 memories from session `c98f110` are intact.
