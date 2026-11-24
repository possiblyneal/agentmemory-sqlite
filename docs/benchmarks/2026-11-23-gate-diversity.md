# Diversify the Injection Gate pool (#542)

## Design

- **Baseline:** `54dc1913120465564c3431dbf05be89c8a087753`. The control gives the Gate the first eligible hits in BM25 order. The isolated treatment gives each covered Session's first hit priority, then backfills its duplicate hits in BM25 order. Uncovered hits keep their first-pass eligibility. Pool size, Lesson reservation, Gate and renderer are unchanged.
- **Cohort:** Two synthetic prompts with fixed ranked input. The first buries relevant evidence behind hits from a single other Session. The second has a relevant second hit from a covered Session whose first hit is irrelevant. Both include one relevant project Lesson. A local stub supplies preassigned reranker scores and the Search adapter checks that the project is forwarded. No private data or holdout used.
- **Pre-measure rule:** More needed decisions visible before the 2,500 ms hook cutoff, with no paired decision loss. Pool size and Lesson delivery must stay equal. Local elapsed time covers the registrar and stub, not a real hook, BM25 pass, or reranker.

## Results

| Arm | Timely needed decisions | Lesson delivered | Gate candidates per trial |
|---|---:|---:|---:|
| BM25 order | 1 of 2 | 2 of 2 | 10 |
| Covered Sessions first | 1 of 2 | 2 of 2 | 10 |

The treatment rescued the crowded-out Session and lost the decision whose relevant second hit was displaced. All four registrar calls finished inside the cutoff. This does not measure live latency.

**Verdict: rejected in the synthetic screen.** Retry with a candidate that preserves strong secondary evidence under the same pool cap, and paired real ranked inputs with Gate scores, visible decision labels, and hook timings.

## Reproduction

`npx tsx eval/runner/gate-diversity.ts` compares the arms against the same loopback stub. `npx vitest run test/eval-gate-diversity.test.ts` verifies the paired gain and loss and the unchanged Lesson slot. The isolated build is under `tmp/gate-diversity/`.
