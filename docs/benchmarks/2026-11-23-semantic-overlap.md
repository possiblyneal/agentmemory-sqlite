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

## Fact keys

A second read-only scan retrieved 42,924 rows and reproduced the 8,916 eligible Facts and 4,530 Facts with a match. All eligible Facts had nonempty subject, relation, and object fields. All 4,530 matched across different subject/relation keys; none matched within the same key. Seven Facts had identical NFC-normalized text to a Fact with a different key. These counts identify where to sample for labeling, not which keys should be merged.

This measures overlap, not semantic equivalence. The input snapshot was not retained, so a later read may yield different counts. The rejected synthetic candidate lost distinct claims in the condition, value, negation and time fixtures; this measurement does not justify reusing it. No Recall evaluation or production change was made for this measurement.

## Operator labels

The Operator labeled 24 disjoint, same-project pairs with different subject/relation keys. The sample included eight pairs in each Jaccard band: `[0.35, 0.5)`, `[0.5, 0.75)`, and `[0.75, 1]`. Scores and keys were hidden during labeling. The Operator labeled three pairs as restatements and 21 as distinct claims.

At `RESTATEMENT_OVERLAP` (0.5), overlap alone would merge all three restatements and 13 of the 21 distinct pairs. The lowest-scoring restatement scored 0.5, while the highest-scoring distinct pair scored approximately 0.905. No single minimum-overlap threshold can retain all three restatements without also merging distinct claims in this sample. This is a pair-level check, not a production error-rate estimate or a Consolidation and Recall replay. The Fact text and labels remain local.

## Offline equivalence screen

Quantized `Xenova/nli-deberta-v3-small` (revision `6bc2a55c7c0f7e2bc68de60bb248e523e2612abb`) ran on the local CPU with remote model loading disabled. The checker called a pair equivalent only when entailment was the top class in both directions. It caught two of the three restatements and preserved 19 of the 21 distinct pairs. The LAN model attempt timed out on the first pair and returned no verdicts.

The quantized `Xenova/nli-deberta-v3-base` (revision `80a99030ce45a69a39ea2a6f50756d03859ff521`) used the same local CPU setup, decision rule, and 24 pairs. It caught two of the three restatements but preserved only 15 of the 21 distinct pairs. Requiring both models to agree caught two restatements and still would merge two distinct pairs. This reuses the original screen; it is not an independent validation set.

Reject both models and their agreement rule for automatic merging. Before retrying, require a distinct candidate to preserve the known counterexamples and test it on fresh labeled pairs before running Consolidation and Recall. No production logic changed.

## Fact object guard

A read-only live scan matched all 24 labeled pairs back to unique same-project, live, cross-key Fact pairs by their exact text. Requiring equal objects after NFC normalization and trimming, in addition to Jaccard ≥ 0.5, caught two of the three restatements and still would merge two of the 21 distinct pairs. Reject the object-and-overlap rule on its own.

Adding bidirectional entailment from the small checkpoint caught one of the three restatements and preserved all 21 distinct pairs. Adding the base checkpoint instead, or requiring both, gave the same counts. This combination was selected after seeing the original labels.

### Fresh blind screen

The small-model combination generated a fresh sample of 12 disjoint, same-project cross-key pairs, excluding all texts from the first screen. The sampler drew eight predicted merges and four abstentions from pairs with equal normalized objects and Jaccard ≥ 0.5. The Operator saw only the two texts, in mixed order. All eight predicted merges were labeled restatements and all four abstentions were labeled distinct. This selected sample tests for failures inside the guard's candidate set, not overall coverage or a production false-merge rate.

### Keyed update replay

A synthetic replay used real Consolidation and Semantic Fact Recall with a stubbed equivalence verdict for one restatement. Both arms then received a changed object, once under each of the two keys in separate runs. Direct reinforcement avoided writing the restatement but retained only the original key. An update under the incoming key left the old claim visible in both arms; the baseline closed the incoming-key row, while the candidate had no such row to close. An update under the original key left the other wording visible on the baseline but only the new claim visible on the candidate. Direct reinforcement makes later behavior depend on which key happened to be stored first. Reject dropping the alternate key. A future candidate must preserve keyed updates or group results without dropping either key.

### Preserve both keys

A scratch-only variant kept the alternate key and its wording in the same Fact row. After a JSON storage round trip and Consolidation handler reinitialization, the replay updated both keys in both orders. The variant initially stored one row instead of the baseline's two. After each first update it recalled the same Fact texts as the baseline, including the untouched key's original wording; after each second update both arms recalled only the two replacement texts. Direct reinforcement without the alternate key lost the untouched wording when the primary key was updated first.

That scratch fixture used a stubbed verdict and an in-memory store. The implementation's separate regression opens a file-backed SQLite store, merges with a stubbed verdict, closes the store, and reopens it with no verifier. Updating either key leaves two live rows and retains the untouched key's wording and original row ID. Export/replace import and snapshot/restore round-trip the alias; the mesh fixture checks inbound receipt only.

### Classifier-backed preservation replay

A synthetic replay used the Consolidation registrar from `c212777e` for the baseline and the candidate registrar with the local q8 DeBERTa worker for the other arm. The model extracted no Facts in this test: a stubbed Summary provider returned fixed XML, while the real entailment worker decided candidate merges. Both arms started each case fresh with a `backups / schedule / nightly` Fact, “The service runs backups every night,” then added a `backups / frequency` Fact. Recall queried `backups` in each affected project.

| Case | Incoming wording | Verifier | Stored rows, baseline → candidate |
|---|---|---|---:|
| Restatement | The service runs its backups every night | Entailed both ways | 2 → 1 |
| Condition | The service runs backups every night only when idle | Declined | 2 → 2 |
| Value | The service runs backups every week | Not called (`weekly` object) | 2 → 2 |
| Negation | The service never runs backups every night | Declined | 2 → 2 |
| Time | The service runs backups every night after midnight | Declined | 2 → 2 |
| Project | The service runs its backups every night | Not called (different project) | 2 → 2 |

The five preservation cases recalled identical text sets in both arms, including one claim per project in the project case. This covers these fixtures only and does not estimate production error rates.

### Coding-life regression check

The default dev split on sandbox instance 37 compared base `c212777e` with the candidate. After restoring the existing embedding worker's expected bundle path, both arms produced the same Recall, precision and no-answer-clean scores:

| Surface | Queries per adapter | Hybrid | BM25 |
|---|---:|---|---|
| Search | 12 | 1.000 / 0.708 / 0.000 | 0.950 / 0.694 / 0.000 |
| Session start | 2 | 0.625 / 1.000 / 1.000 | 0.625 / 1.000 / 1.000 |
| Prompt submit | 9 | 0.861 / 1.000 / 1.000 | 0.861 / 1.000 / 1.000 |

This run checks general Recall, not the classifier or Consolidation; the SQLite fixture and labeled screens cover those separately.
