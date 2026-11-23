# Live Semantic Fact overlap — 2026-11-23

A read-only local semantic-list response contained 42,924 rows, including 41,400 live rows (`isLatest !== false`). Of the 8,916 live Facts with a nonempty explicit project and string Fact text, 4,530 (50.8%) had at least one same-project partner at word-set Jaccard ≥ 0.5. The other 32,484 live rows were excluded; no project was inferred from Session references.

The probe checked the response length against its reported total, grouped eligible rows by exact project key, and used the repository's `jaccardText` and `jaccardOverlap`. Each row counted at most once; both members of a matching pair could count. Buckets below are ordered by size, without project names.

| Bucket | Eligible Facts | Facts with a match |
|---:|---:|---:|
| 1 | 2,756 | 1,354 |
| 2 | 1,418 | 770 |
| 3 | 1,183 | 662 |
| 4 | 584 | 318 |
| 5 | 567 | 257 |
| 6 | 549 | 223 |
| 7 | 504 | 295 |
| 8 | 447 | 246 |
| 9 | 279 | 123 |
| 10 | 220 | 124 |
| 11 | 203 | 64 |
| 12 | 115 | 71 |
| 13 | 42 | 19 |
| 14 | 34 | 4 |
| 15 | 15 | 0 |

This measures overlap, not semantic equivalence. The input snapshot was not retained, so a later read may yield different counts. The rejected synthetic candidate lost distinct claims in the condition, value, negation and time fixtures; this measurement does not justify reusing it. No Recall evaluation or production change was made for this measurement.
