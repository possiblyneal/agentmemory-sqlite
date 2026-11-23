# Recovered Session backups — 2026-11-22

**Hypothesis (#512):** Keeping a Session row after stale-session recovery preserves the retained Observations its backups enumerate, without changing the backup format.

**Method:** Run the recovered-Session cases in `test/export-import.test.ts` on baseline `954c6583` and candidate `e9c54b37`, using the same synthetic fixture on both. Run stale-session recovery through the real stop handler with a stub provider, take a backup, and restore into a fresh store. Check for the Session and Observation in the backup and restored state, then for the Observation in same-project search but not another project's search.

| Restore path | Baseline | Candidate |
|---|---|---|
| Full export → replace import | Session and Observation missing; same-project search misses the Observation | Session and Observation restored; project scope preserved |
| Snapshot → restore | Session and Observation missing; same-project search misses the Observation | Session and Observation restored; project scope preserved |

**Verdict:** Keep for both measured backup paths. This fixture does not cover previously orphaned Observation buckets, existing backup files, or live-store recovery.
