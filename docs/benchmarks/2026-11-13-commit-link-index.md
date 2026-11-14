# 2026-11-13 — commit text indexed through the commit-link path

**Commit:** the #403 branch (`src/functions/commit-index.ts`, `src/triggers/api.ts`, `src/hooks/post-commit.ts`, `eval/runner/replay-external.ts`)
**Bench:** `eval:replay --from-checkpoints` over the Operator's own transcripts, on the #396 checkpoints (#403)
**N:** 141 dev Sessions from 12 projects (235 loaded, cap 40, min 2 turns); 30 key items (20 on the typical rollup)
**K:** an Injection and a search are scored whole, as in the other replay scorecards
**Hardware:** Linux 6.12, 12 cores, Node 22
**Embeddings:** on-device (the default local model)
**LLM:** none for this scorecard (synthetic compression, no reranker gate); the LLM and gate rerun is not part of it

## Headline

The built path reproduces the #396 result. Linking each commit through `POST /agentmemory/session/commit`, the route the post-commit hook takes, delivers 10 of 30 key items against 4 for `none` (7 gained, 0 lost, exact McNemar p = 0.0156), the target of 10. The used share of injected items is 7.2% against 5.6%.

## Per arm

Pooled over the 141 Sessions. Both arms restore the same #396 checkpoints; only the ingest differs.

| Arm | Ingest | Key delivered | Used / injected | Chars per used item | External used / injected |
|---|---|---|---|---|---|
| none | none | 4/30 | 240/4277 (5.6%) | 6991 | 0/0 |
| commits (#396) | `/observe`, item `files` | 10/30 | 314/4487 (7.0%) | 5603 | 91/591 |
| commits (built) | `/session/commit`, daemon-stored `files` | 10/30 | 324/4503 (7.2%) | 5454 | 97/595 |

Typical rollup (without `agentmemory-sqlite` and `medical-researcher`): `none` 1/20 and 4.7% used; built commits 7/20 and 6.7%.

## What changed in the path

Before this change the commit-link path stored a commit's message and changed paths in `mem:commits` and indexed neither, so no search or Injection could return a commit. It now writes each linked commit as one Observation `obs_commit_<sha>` of a `commits-<project>` Session (synthetic, `files` = the commit's paths, dated by `authoredAt`), indexed in BM25 and the vector index. The hook sends `project` and `cwd`; the stored `CommitLink` and the endpoint shape are unchanged.

## Methodology

- **Ingest:** `--external-ingest commit-link` posts each corpus commit of the arm to `/agentmemory/session/commit` (message split from the corpus text at its `Files:` list, `authoredAt` = the corpus date, `files` from the corpus), then reads the rows the daemon stored under `commits-<project>`. Scored `files` are the stored ones, so a path the daemon dropped would not count.
- **Everything else** is the #396 harness: same checkpoints, same dated-before-the-Session rule, same used rule, `--resume` on the same instance layout.

## Limits

- Synthetic compression and no reranker gate, as #396. The LLM-compression and gate rerun the issue asks for is a long run (about an hour per Session on the broker, 33 Sessions) and is reported separately when it finishes; this scorecard does not claim the size under the gate.
- 27 of 30 key items are file keys, which is what a changed-path list answers; no decision or correction is gained.
- No history backfill: only commits linked after this change are indexed, so a repo's earlier history is unsearchable until a backfill exists. That is a new public command and is left to its own issue.
- One Operator, 12 projects, one replay per arm.

## Reproduce

```sh
git checkout <this PR's merge commit>
npm ci && npm run build
npm run eval:replay -- --projects=<dirs> --cap 40 --min-turns 2 --instance 46 \
  --from-checkpoints tmp/ext396/save/checkpoints --external-corpus tmp/ext396/corpus.json \
  --external-arm commits --external-ingest commit-link --resume --out tmp/ext403/arm-commit-link
npm run eval:external-compare -- tmp/ext403/cmp
```
