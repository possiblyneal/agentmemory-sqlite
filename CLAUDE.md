# agentmemory — Agent Instructions

## Goal

Put the right Memory in front of an Agent at the moment it needs it, and pay as little as
possible to be able to do that. Every feature here is judged against that sentence.

- **Right content** — Recall returns what bears on the work in hand, not everything that
  matched the query. A near-miss that costs the Agent a read is worse than one fewer result.
- **Right moment** — context arrives at hook boundaries (session start, user prompt,
  pre-compact) without the Agent having to know to ask. Memory the Agent must remember to
  query is memory that goes unused.
- **Right scope** — results are bounded by project and Session
  (`scope: "project" | "global"`, `src/types.ts:309`). Branch is not a bound: every branch
  and worktree of a repo shares one project (`test/branch-recall.test.ts`). One repo's work
  never surfaces in another's.
- **Least record that restates** — store the smallest durable claim that reconstructs a
  decision later: the conclusion and why, not the transcript that produced it. Observations
  are raw and cheap; a Memory earns its place by being worth re-reading.
- **Durable beats recent** — a correction that changes future behaviour outranks a log of
  what happened. Volume is a cost, not a measure of success; Eviction is expected, not a
  failure mode.
- **Never on the critical path** — memory accelerates a Session and is never a dependency of
  one. A dead daemon, a missed hook, or a slow Recall degrades the work; it does not block
  it.
- **The Operator's attention is the scarce resource** — disk growth, restarts, and noisy
  recall are the real costs, and they land on one person.

## Architecture

agentmemory is a persistent memory system for AI coding agents. It runs as a single process on one in-process Engine ([ADR 0001](./docs/adrs/0001-single-in-process-sqlite-engine.md)) — importing `src/index.ts` *is* starting the daemon. There is no separate runtime to install, spawn, adopt or stop.

The Engine keeps the three primitives (Worker/Function/Trigger) as its internal dispatch model: work is registered by id with `sdk.registerFunction`/`sdk.registerTrigger` and invoked with `sdk.trigger()`. Route everything through those — never reach past the Engine to open your own SQLite handle.

- **Engine**: `createInprocSdk()` in `src/engine/inproc/sdk.ts`, over `node:sqlite`. It binds the ports itself. Engine-facing types (`ISdk`, `ApiRequest`, `TriggerAction`) come from `src/engine/types.ts` — this repository owns them; there is no external SDK package.
- **State**: `SqliteState` (`src/engine/inproc/state.ts`), one file at `AGENTMEMORY_SQLITE_PATH` (default `<data-dir>/agentmemory.sqlite`). Reach it as `StateKV` over the scopes in `src/state/schema.ts`.
- **Ports**: REST 3111 is the anchor (`III_REST_PORT`); streams is REST+1 and the viewer REST+2. `--instance N` shifts the whole block by 100.
- **Build**: TypeScript → ESM via tsdown, output to `dist/` and, for the 12 hook entries, to
  `plugin/scripts/*.mjs` — those are committed build output, and tsdown gives them mode 755 for
  their shebang. Regenerate them with `npm run build`; never hand-edit one or reset its mode.
  An installed plugin runs its own cached copy, and `claude plugin update` skips any update
  that leaves `plugin.json`'s version unchanged. A hook change therefore reaches Claude Code
  only after `claude plugin uninstall` and then `claude plugin install`.
- **Test**: vitest (`npm test` excludes integration tests; `vitest.config.ts` excludes `tmp/**`, where scratch worktrees live)
- **Runtime floor**: the Engine and its packages need Node >=22.13 — `node:sqlite` is unflagged from 22.13, so anything older fails at import. CI runs 22/24/26 on ubuntu + macos; do not re-add a Node 20 leg. `integrations/filesystem-watcher` is a separate process that never imports `node:sqlite`, so its `>=20` stands.

## Consistency Rules

**When adding or removing MCP tools, you MUST update ALL of the following:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in the `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint registration
4. `src/index.ts` — function registration + endpoint count in the log line
5. `test/mcp-standalone.test.ts` — per-group tool count assertion
6. `test/tool-count-consistency.test.ts` — `EXPECTED_TOOL_COUNT`
7. `plugin/.claude-plugin/plugin.json` — tool count in description
8. `npm run skills:gen` — regenerates the counts and tables in `plugin/skills/*/REFERENCE.md`

**When adding REST endpoints, you MUST update:**
1. `src/triggers/api.ts` — endpoint registration
2. `src/index.ts` — endpoint count in the log line
3. `npm run skills:gen` — regenerates the endpoint count and route table

**When bumping version, you MUST update ALL of the following:**
1. `package.json` — version field
2. `src/version.ts` — VERSION constant and type union
3. `src/types.ts` — ExportData version union
4. `src/functions/export-import.ts` — supportedVersions set
5. `test/export-import.test.ts` — version assertion
6. `plugin/.claude-plugin/plugin.json` — version field
7. `plugin/plugin.json` (when present) — version field

**When adding new KV scopes:**
1. `src/state/schema.ts` — add to the KV object
2. `src/types.ts` — add the corresponding interface

**When adding new audit operations:**
1. `src/types.ts` — add to AuditEntry.operation union type

## Code Patterns

Engine-facing types come from `src/engine/types.ts` (`ISdk`, `ApiRequest`, `Response`, `TriggerAction`), never from a package. Each module exports one `registerXFunction(sdk: ISdk, kv: StateKV)` that `src/index.ts` calls at boot.

### Function Registration
```typescript
sdk.registerFunction(
  "mem::your-function",
  async (data: { ... }) => {
    // validate inputs
    // do work via kv.get/kv.set/kv.list
    // record audit via recordAudit()
    return { success: true, ... };
  },
);
```

### REST Endpoint Registration
```typescript
sdk.registerFunction(
  "api::your-endpoint",
  async (req: ApiRequest<YourBody>): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!req.body?.requiredField) {
      return { status_code: 400, body: { error: "requiredField is required" } };
    }
    const result = await sdk.trigger({
      function_id: "mem::your-function",
      payload: pickFields(req.body, ["requiredField", "optionalField"]),
    });
    return { status_code: 200, body: result };
  },
);
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: {
    api_path: "/agentmemory/your-path",
    http_method: "POST",
  },
});
```
`pickFields` forwards the named fields unchanged and never the raw body; when a field needs
parsing or a 400 on a bad value, build the payload literal instead (see `api::consolidate`).
Auth is the inline `checkAuth(req, secret)` above, which is what nearly every endpoint in
`src/triggers/api.ts` does. A `middleware_function_ids: ["middleware::api-auth"]` on the
trigger is the minority form — follow whichever the endpoints around yours use, and do not
put both on one endpoint.

### Observations on a full disk
Telemetry hooks never retry, so the daemon keeps what it can. When an Observation's row write
(or its image file) hits a full disk, `api::observe` answers 202 `{queued: true}` and holds it
in `ObserveRetryQueue` (`src/functions/observe-retry.ts`): in memory, capped at 64 MiB, and
replayed every 30 s until a write succeeds. While anything is queued, new Observations queue
behind it so each Session stores them in arrival order; past the cap one is dropped (500), never
written ahead of the queue. A failure after the row is stored is never queued, since replaying
it would duplicate the row. Session-cap eviction runs only after the row is stored, and its
errors are logged, not returned. A daemon restart before the disk frees loses the queue.

### Graph Eviction
Every path that hard-deletes Observations or Memories (`mem::evict`, `mem::observe` session-cap
eviction, `mem::auto-forget`, `mem::forget`, `mem::retention-evict`, `mem::governance-delete`,
`mem::governance-bulk`) calls `evictGraphForSources(kv, ids, functionId)`
(`src/functions/graph-eviction.ts`) after the rows are gone, in place of
`unlinkObservationNodes`. It removes each Entity and Relation whose Provenance is non-empty,
below `getMaxSourceObservationIds()`, and names no stored Observation or Memory, with its
incident Relations, every `gidx`/name/edge-key/degree/edge-history row and the Graph Snapshot
counts. It decides and deletes under `GRAPH_WRITE_LOCK`, which every graph writer
(`persistGraphDelta`, temporal-graph, cascade, file-node merge, mesh sync) also holds; it never throws,
and is audited as `delete` with `resource: "graph"`. Candidates come only from the evicted
sources' obs-node rows: there is no sweep, so records orphaned before this existed stay on
disk. Import `replace` and snapshot restore rewrite the graph from their own file and do not
call it.

### MCP Tool Handler
```typescript
case "memory_your_tool": {
  // validate args with typeof checks
  // parse CSV args: args.field.split(",").map(t => t.trim()).filter(Boolean)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
}
```

### Injection Gate
Prompt-submit Injection (`mem::prompt-context`) is reranker-gated and fails open to the BM25 selection (`src/functions/prompt-rerank.ts`; `AGENTMEMORY_PROMPT_RERANK`, `_URL`, `_MIN`, `_TIMEOUT_MS`, capped at 1000 ms to stay inside the hook's 1500 ms `INJECT_TIMEOUT_MS`; state under `/diagnostics` `injections`). A reply that does not score every candidate exactly once is malformed and falls back. It is on by default and its default host is unreachable from CI, so `vitest.config.ts` and the eval sandbox set `AGENTMEMORY_PROMPT_RERANK=off`; a test that exercises the gate stubs the endpoint with a local `node:http` server.

### Hook Scripts
Hook scripts in `src/hooks/` are standalone Node.js scripts (no Engine import). They read JSON from stdin, make HTTP calls to the REST API, and exit. There are two patterns depending on whether Claude Code consumes the script's stdout:

- **Context-injecting hooks** (`pre-compact`, `prompt-submit`, `session-start`) write recalled context to stdout for Claude Code to inject. These MUST use `try/catch` with `await fetch(..., { signal: AbortSignal.timeout(N) })` — the script has to wait for the response before exiting, and the timeout is the only bound on hang time. `prompt-submit` injects only on Claude Code's `UserPromptSubmit` event, still sends its observe fire-and-forget, and arms the exit timer after the awaited Injection. On a timeout, connection error or non-2xx reply they call `recordMissedInjection()` (`src/hooks/_missed-injection.ts`), which appends to the size-capped `~/.agentmemory/missed-injections.jsonl` that `/diagnostics` (`injections`) reports; an empty reply is not a Missed Injection.
- **Telemetry-only hooks** (`notification`, `post-tool-failure`, `post-tool-use`, `stop`, `session-end`, `subagent-start`, `subagent-stop`, `task-completed`) write nothing to stdout. These MUST use fire-and-forget `fetch(..., { signal: AbortSignal.timeout(N) }).catch(() => {})` paired with `setTimeout(() => process.exit(0), 500).unref()`. The unawaited fetch dispatches the request; the unref'd `setTimeout` force-exits the process after the request has been flushed to the local daemon's socket buffer (~500ms is enough for single-request hooks; use 1500ms for multi-request hooks like `stop` and `session-end` so all fetches have time to start, especially when `AGENTMEMORY_URL` points to a remote daemon). Without the `setTimeout` Node keeps the event loop alive waiting for any in-flight fetch to settle, which means the hook still blocks Claude Code's next-prompt boundary for up to the AbortSignal duration — exactly the bug fire-and-forget is meant to fix.

Hooks and the MCP shim name the project with `resolveProject()` (`src/hooks/_project.ts`): the main checkout's basename, shared by every worktree. The first repo to claim a basename (recorded in `~/.agentmemory/project-names.json`) keeps it bare; a later same-named repo gets a `-<6 hex>` suffix from its origin URL, or its common-dir path when it has no remote.

## Coding Standards

- TypeScript, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- Use `fingerprintId()` for content-addressable dedup, `generateId()` for unique IDs
- Parallel operations where possible (`Promise.all` for independent kv writes/reads)
- Input validation at system boundaries (MCP handlers, REST endpoints)
- REST endpoints must whitelist fields — never pass raw request body to `sdk.trigger()`
- Use `recordAudit()` for state-changing operations
- Timestamps: capture once with `new Date().toISOString()` and reuse
- Outbound LLM and embedding calls go through `fetchWithTimeout`, which honors the caller's
  timeout exactly. One deadline covers every retry and the read of the response body. LLM
  providers fall back to `AGENTMEMORY_LLM_TIMEOUT_MS`, then 60s (the OpenAI LLM provider
  resolves `OPENAI_TIMEOUT_MS` first); embedding providers pass `EMBED_TIMEOUT_MS` (30s), so
  a hung embedder fails fast and the index fill backfills the row. The in-process Engine has
  no invocation timeout, so never reintroduce a ceiling that clamps that bound
  ([ADR 0001](./docs/adrs/0001-single-in-process-sqlite-engine.md)).

## Testing

- `npm run typecheck` must report 0 errors and `npm test` (2,050+ tests) must pass before a PR; CI runs both
- Mock pattern: hand-rolled fakes passed straight into the registrar, not module mocks. A `mockKV()` backed by a `Map<string, Map<string, unknown>>` implementing `get/set/delete/list`, and a `mockSdk()` holding a `Map` of registered handlers whose `trigger()` looks the handler up by `function_id` and calls it. `vi.mock` is reserved for `../src/logger.js` and `../src/state/keyed-mutex.js`.
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests
- Recall quality is measured by `npm run eval:coding-life` (after `npm run build`), which scores search, session-start and prompt-submit Injections separately against a throwaway daemon under `tmp/eval-sandbox/`; see `eval/README.md`. A change to Recall or Injection content reruns it and, when the numbers move, publishes a new dated scorecard in `docs/benchmarks/`
- `npm run eval:replay -- --projects=<dir>,...` replays the Operator's own `~/.claude/projects` transcripts into a throwaway daemon and scores each Goal line against an answer key derived from the transcripts (`eval/README.md`). It is not part of CI, and its output stays under `tmp/eval-replay/` because it quotes private transcripts; only aggregates reach `docs/benchmarks/`
- CI gates Recall quality with `npm run eval:gate` (ubuntu / Node 22 leg only, BM25-only, ~10s): it always starts a fresh sandbox, never a live daemon, and fails with a per-metric diff when any metric in `eval/baselines/coding-agent-life-v2.json` falls below its floor minus the tolerance. A PR that moves those numbers on purpose updates that file and says why

## Supported hosts

Claude Code is the only supported host. The Operator installs it through the marketplace plugin
(`plugin/.claude-plugin/plugin.json`, which loads `plugin/hooks/hooks.json`, `plugin/.mcp.json`
and `plugin/skills/`). `agentmemory connect` (`installClaudeCode` in `src/cli/connect/claude-code.ts`)
wires only the MCP server into `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is
set in the process environment); `connect claude-code` is kept as an alias. Build every path
into Claude Code's config with `getClaudeConfigDir()` / `getClaudeJsonPath()` in
`src/config.ts`; never join `homedir()` with `.claude` directly.
`CONNECT_FLAGS` in `src/cli/connect/index.ts` is the source of truth for its accepted flags, the
`--help` text and the generated `plugin/skills/agentmemory-agents/REFERENCE.md`. Do not add a
host picker, connect adapters, per-host hook manifests or host payload shims in `src/hooks/` for
any other agent.

## Relationship to upstream

This fork is deliberately divergent: `rohitg00/agentmemory` is where the code came from and
nothing more. Do not merge, rebase or cherry-pick from it, and do not restore a branch, tag or
file merely because upstream still carries it. `origin` carries `main` plus the branches of
live PRs — an inherited upstream branch is deleted, never tracked.

In PR bodies, issues, comments and commit messages, write an upstream issue or PR as
`rohitg00/agentmemory#N`. A bare `#N` links to this fork, so it must only ever mean this
fork's own issue or PR.

Plugin distribution metadata (`homepage`, `repository`, marketplace sources, `plugin install`
and `skills add` commands) must name `possiblyneal/agentmemory-sqlite`. Installing from
upstream pulls upstream's 8 skills over this fork's 17. npm package metadata still names
upstream deliberately: this fork does not own those package names.

Nothing is published from here — there is no release workflow and `dist/` is gitignored, so
the only install path is clone → `npm ci` → `npm run build` →
`npm link`. Any doc that tells a user how to install must describe that path, never
`npx`/`npm install -g @agentmemory/*`, which resolve to upstream's code. The only files that may
quote those commands are the ones `test/consistency.test.ts` exempts; that list is the one place
exceptions live. `plugin/.mcp.json` and the entry `agentmemory connect` writes both run this fork's own
`agentmemory mcp` from `PATH`, which defaults an omitted `project` to the one resolved from its
cwd (`src/mcp/default-project.ts`; an explicit `project` or `scope: "global"` wins). Never point
either at the `@agentmemory/mcp` npm shim, which passes no project. The translated `READMEs/` were deleted rather than kept
stale — do not re-add translations without a way to keep them current.

`docs/upstream-issue-triage.yaml` scores every open upstream issue by severity and fix
difficulty. It is a survey of defects in the shared code lineage, used to pick what is worth
fixing *here* — it is not a backlog to merge from, and it is a dated snapshot, not a live
mirror. Refresh the row set from `gh issue list`; the `disposition`, `status`, `fixed_by`
and `wont_fix_reason` fields are hand-written verdicts, updated as fixes land here. Its rows
cross-link the open upstream PRs that claim to fix them; `docs/upstream-pr-triage.yaml`
covers the remaining PRs — the ones that reference no open issue — scored by whether they
land in code this fork carries. Both are read for the defect and the diagnosis, never for
the patch.

Every row in both files carries a `disposition`: `already-fixed` (verified against this tree;
`fixed_by`/`status` names the evidence), `wont-fix` (out of scope here — most often
upstream-only housekeeping, or code this fork does not carry: the iii engine, npm publishing,
Windows CI, the deploy tree, a host other than Claude Code, a third-party LLM or
embedding provider beyond the OpenAI-compatible, Anthropic and local paths,
non-English language support, or a multi-user feature (one Operator runs the daemon);
`wont_fix_reason`
says which), or `candidate` — the working set. A row that was opened against
this tree also carries `status`, whose leading token says what the read found
(`fixed-here`, `present-here`, `partly-present-here`, `unresolved`). No `status` means
unchecked: the note is still upstream's claim, not a verified defect.

## Current Stats (v0.9.29)

`test/consistency.test.ts` enforces the install-path rule above (with its own exemption list) and the MCP tool and REST endpoint counts here; `test/tool-count-consistency.test.ts` enforces the hook and skill counts.

- 55 MCP tools (all visible by default, `AGENTMEMORY_TOOLS=core` for the 8 essentials)
- 134 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 10 hooks, 17 skills
- 260+ registered functions
- 2,050+ tests

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on this fork (`possiblyneal/agentmemory-sqlite`), driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.
Accepted-but-unscheduled work waits in `docs/backlog.md` until it becomes an issue.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. `CONTEXT.md` holds the glossary — use its terms in specs, issues, and commit messages. ADRs live in `docs/adrs/`; read any whose scope covers what you are touching before editing. See `docs/agents/domain.md`.

- [ADR 0001](./docs/adrs/0001-single-in-process-sqlite-engine.md) — this fork runs only the in-process SQLite Engine.
