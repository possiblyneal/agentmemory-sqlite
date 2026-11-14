# 2026-11-13 — external text in Recall (commits, PRs, issues)

**Commit:** `d51964c2` plus the harness in this PR (`eval/runner/external-text.ts`, `external-corpus.ts`, `replay-external.ts`, `compare-external.ts`)
**Bench:** `eval:replay` over the Operator's own transcripts, probing saved checkpoints (#396)
**N:** 141 dev Sessions from 12 projects (235 loaded, cap 40, min 2 turns); 30 key items (20 on the typical rollup)
**K:** an Injection and a search are scored whole, as in the other replay scorecards
**Hardware:** Linux 6.12, 12 cores, Node 22
**Embeddings:** on-device (the default local model)
**LLM:** none (synthetic compression, no reranker gate)

## Headline

Commit text pays and PR and issue text does not. Adding each repo's commits as Observations lifts key items delivered from 4 to 10 of 30 (7 gained, 0 lost, exact McNemar p = 0.0156) and the used share of injected items from 5.6% to 7.0%. PRs alone and issues alone deliver no key item that `none` missed, and add 0.0 to 0.3 points of used share. Every arm containing commits scores the same 10/30; adding PRs or issues on top of commits changes the used share by at most 0.1 point.

Arm to build: commits only, indexed through the existing commit-link path (`POST /agentmemory/commits`), not a new connector, and not PRs or issues. This PR builds nothing of it; the follow-up is an issue.

## Per arm

Pooled over the 141 Sessions. Key delivered counts a key item reached by an Injection or a search.

| Arm | Key delivered | Used / injected | Chars per used item | External used / injected |
|---|---|---|---|---|
| none | 4/30 | 240/4277 (5.6%) | 6991 | 0/0 |
| commits | 10/30 | 314/4487 (7.0%) | 5603 | 91/591 |
| prs | 4/30 | 256/4347 (5.9%) | 6702 | 18/172 |
| issues | 4/30 | 241/4320 (5.6%) | 7032 | 11/148 |
| commits+prs | 10/30 | 321/4509 (7.1%) | 5540 | 100/640 |
| commits+issues | 10/30 | 315/4512 (7.0%) | 5627 | 95/653 |
| prs+issues | 4/30 | 256/4368 (5.9%) | 6737 | 28/271 |
| commits+prs+issues | 10/30 | 321/4510 (7.1%) | 5545 | 105/692 |

Typical rollup (without `agentmemory-sqlite` and `medical-researcher`): `none` 1/20 and 4.7% used; every commits arm 7/20 and 6.5% to 6.7%; `prs` 1/20 and 5.0%; `issues` 1/20 and 4.7%. The direction holds.

Paired against `none` on key items (exact McNemar, `mcnemarExact`): each of the four commits arms 7 vs 0, p = 0.0156; `prs`, `issues` and `prs+issues` 0 vs 0, p = 1.

By channel for `commits`: Injection reached 5 key items against 3 for `none`; search reached 10 against 4. All 7 gained items are `file` key items (3 homelab, 3 devex, 1 inference-runtime-broker); 4 came through search alone, 3 through both. Injection and search latency did not move: prompt-context p50 96 ms with commits against 108 ms without, p99 586 against 629.

## Cost

The corpus holds 4,869 commits (3.8 MB of text), 770 PRs (1.9 MB) and 1,389 issues (2.2 MB) against a 272 MB store, so commits are about 1.4% of it. The replay's `bytesPerUsedItem` is not comparable across arms here: it reads the store before the external items are ingested, so the arms' drop in it (1.20 MB to 0.90 MB) comes from the larger used count over an unchanged byte figure, not from cheaper storage. Injected chars per used item fall from 6,991 to 5,603 with commits. External items are 91 of the 314 used items in the `commits` arm.

## Methodology

- **Corpus:** `npm run eval:external-corpus` reads each project's checkouts: `git log --branches --remotes=origin --no-merges` with changed paths, and `gh pr|issue list --state all`. Text is capped at 4000 chars. Timestamps are the committer date for commits and `closedAt ?? updatedAt` for PRs and issues, so an item enters a Session only when it was already settled before the Session started.
- **Ingest:** each probed checkpoint is restored, then the arm's items dated before that Session's start are posted to `/agentmemory/observe` as `prompt_submit` Observations, one Session per project and source, and the checkpoint's own Observations are probed with them. One save pass (synthetic compression, 235 Sessions) served all 8 arms, so the arms differ only by what is ingested.
- **Scoring:** an external item counts as used when it names a file the Session touched, delivers a key item, or bears on a typed turn, the same rule as every other item. A commit carries its changed paths as `files`, so a commit that touched a file an earlier Session read delivers that file key.
- **Resume:** probe passes take `--resume`, which keeps finished Sessions in `scores.ndjson`. One launch of the first four arms was killed by a stray `pkill` and finished through it.

## Limits

- 30 key items is small, and 27 of them are file keys, which is exactly what a commit's changed-path list answers. The gain is on file delivery, mostly through search. It does not show commits delivering corrections or decisions: all 7 gained items are file keys.
- PR and issue bodies are as of now, though the timestamp rule keeps them out of earlier Sessions. A body edited after a Session carries later knowledge.
- No LLM compression and no reranker gate: with the gate on, external items would compete for the 10-candidate pool, and the injected count may fall.
- One Operator, 12 projects, one replay per arm.

## Reproduce

```sh
git checkout <this PR's merge commit>
npm ci && npm run build
npm run eval:external-corpus -- --out tmp/ext396/corpus.json <repo checkout>...
npm run eval:replay -- --projects=<dirs> --cap 40 --min-turns 2 --instance 44 --save-checkpoints --out tmp/ext396/save
for arm in none commits prs issues commits+prs commits+issues prs+issues commits+prs+issues; do
  npm run eval:replay -- --projects=<dirs> --cap 40 --min-turns 2 --instance 45 \
    --from-checkpoints tmp/ext396/save/checkpoints --external-corpus tmp/ext396/corpus.json \
    --external-arm $arm --resume --out tmp/ext396/arm-$arm
done
npm run eval:external-compare -- tmp/ext396
```

## Notes

The result says which source to index, not that the gain would reach the Operator unchanged: the harness hands each commit its changed paths as `files`, and the daemon's commit-link path (`CommitLink`, `mem:commits`) must carry the same paths to repeat it. Check that in the follow-up before building.
