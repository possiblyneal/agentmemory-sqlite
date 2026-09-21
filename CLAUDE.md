# agentmemory — Agent Instructions

## Architecture

agentmemory is a persistent memory system for AI coding agents. It runs as a single process on one in-process Engine ([ADR 0001](./docs/adrs/0001-single-in-process-sqlite-engine.md)) — importing `src/index.ts` *is* starting the daemon. There is no separate runtime to install, spawn, adopt or stop.

The Engine keeps the three primitives (Worker/Function/Trigger) as its internal dispatch model: work is registered by id with `sdk.registerFunction`/`sdk.registerTrigger` and invoked with `sdk.trigger()`. Route everything through those — never reach past the Engine to open your own SQLite handle.

- **Engine**: `createInprocSdk()` in `src/engine/inproc/sdk.ts`, over `node:sqlite`. It binds the ports itself. Engine-facing types (`ISdk`, `ApiRequest`, `TriggerAction`) come from `src/engine/types.ts` — this repository owns them; there is no external SDK package.
- **State**: `SqliteState` (`src/engine/inproc/state.ts`), one file at `AGENTMEMORY_SQLITE_PATH` (default `<data-dir>/agentmemory.sqlite`). Reach it as `StateKV` over the scopes in `src/state/schema.ts`.
- **Ports**: REST 3111 is the anchor (`III_REST_PORT`); streams is REST+1 and the viewer REST+2. `--instance N` shifts the whole block by 100.
- **Build**: TypeScript → ESM via tsdown, output to `dist/` and, for the 14 hook entries, to
  `plugin/scripts/*.mjs` — those are committed build output, and tsdown gives them mode 755 for
  their shebang. Regenerate them with `npm run build`; never hand-edit one or reset its mode.
- **Test**: vitest (`npm test` excludes integration tests)
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
8. `plugin/plugin.json` and `plugin/.mcp.copilot.json` (when present) — tool count or MCP exposure
9. `npm run skills:gen` — regenerates the counts and tables in `plugin/skills/*/REFERENCE.md`

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
    const body = (req.body ?? {}) as Record<string, unknown>;
    // validate + whitelist fields (never pass raw body to sdk.trigger)
    const result = await sdk.trigger({
      function_id: "mem::your-function",
      payload: { ... },
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
Auth is the inline `checkAuth(req, secret)` above, which is what nearly every endpoint in
`src/triggers/api.ts` does. A `middleware_function_ids: ["middleware::api-auth"]` on the
trigger is the minority form — follow whichever the endpoints around yours use, and do not
put both on one endpoint.

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

### Hook Scripts
Hook scripts in `src/hooks/` are standalone Node.js scripts (no Engine import). They read JSON from stdin, make HTTP calls to the REST API, and exit. There are two patterns depending on whether Claude Code consumes the script's stdout:

- **Context-injecting hooks** (`pre-tool-use`, `pre-compact`, `session-start`) write recalled context to stdout for Claude Code to inject. These MUST use `try/catch` with `await fetch(..., { signal: AbortSignal.timeout(N) })` — the script has to wait for the response before exiting, and the timeout is the only bound on hang time.
- **Telemetry-only hooks** (`notification`, `post-tool-failure`, `post-tool-use`, `prompt-submit`, `stop`, `session-end`, `subagent-start`, `subagent-stop`, `task-completed`) write nothing to stdout. These MUST use fire-and-forget `fetch(..., { signal: AbortSignal.timeout(N) }).catch(() => {})` paired with `setTimeout(() => process.exit(0), 500).unref()`. The unawaited fetch dispatches the request; the unref'd `setTimeout` force-exits the process after the request has been flushed to the local daemon's socket buffer (~500ms is enough for single-request hooks; use 1500ms for multi-request hooks like `stop` and `session-end` so all fetches have time to start, especially when `AGENTMEMORY_URL` points to a remote daemon). Without the `setTimeout` Node keeps the event loop alive waiting for any in-flight fetch to settle, which means the hook still blocks Claude Code's next-prompt boundary for up to the AbortSignal duration — exactly the bug fire-and-forget is meant to fix.

## Coding Standards

- TypeScript, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- Use `fingerprintId()` for content-addressable dedup, `generateId()` for unique IDs
- Parallel operations where possible (`Promise.all` for independent kv writes/reads)
- Input validation at system boundaries (MCP handlers, REST endpoints)
- REST endpoints must whitelist fields — never pass raw request body to `sdk.trigger()`
- Use `recordAudit()` for state-changing operations
- Timestamps: capture once with `new Date().toISOString()` and reuse

## Testing

- All tests must pass before PR: `npm test` (1,850+ tests)
- Mock pattern: hand-rolled fakes passed straight into the registrar, not module mocks. A `mockKV()` backed by a `Map<string, Map<string, unknown>>` implementing `get/set/delete/list`, and a `mockSdk()` holding a `Map` of registered handlers whose `trigger()` looks the handler up by `function_id` and calls it. `vi.mock` is reserved for `../src/logger.js` and `../src/state/keyed-mutex.js`.
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests

## Supported hosts

19 `connect` adapters, enumerated by `ADAPTERS` in `src/cli/connect/index.ts` — that array is
the source of truth for the count in the generated
`plugin/skills/agentmemory-agents/REFERENCE.md`. Cursor and Codex are not supported.

Two survivors are named for Codex but are not Codex-specific — do not delete them with a host:
`plugin/hooks/hooks.codex.json` is the manifest `connect dsh` merges (`src/cli/connect/dsh.ts`),
and `src/cli/connect/codex-hooks.ts` is the shared merge engine behind Claude Code
`--with-hooks`, Droid, Devin and dsh, and also exports the `findPluginRoot` helper that
`antigravity-cli.ts` and `pi.ts` import.

## Relationship to upstream

This fork is deliberately divergent: `rohitg00/agentmemory` is where the code came from and
nothing more. Do not merge, rebase or cherry-pick from it, and do not restore a branch, tag or
file merely because upstream still carries it. `origin` carries `main` plus the branches of
live PRs — an inherited upstream branch is deleted, never tracked.

Plugin distribution metadata (`homepage`, `repository`, marketplace sources, `plugin install`
and `skills add` commands) must name `possiblyneal/agentmemory-sqlite`. Installing from
upstream pulls upstream's 8 skills over this fork's 17. npm package metadata still names
upstream deliberately: this fork does not own those package names.

Nothing is published from here — there is no release workflow and `dist/` is gitignored, so
the only install path is clone → `npm ci` → `npm run build` →
`npm link`. Any doc that tells a user how to install must describe that path, never
`npx`/`npm install -g @agentmemory/*`, which resolve to upstream's code. The one exception is
the `@agentmemory/mcp` shim wherever it is invoked as a proxy — `plugin/.mcp.json` and
`plugin/.mcp.copilot.json` — because in proxy mode the tool surface comes from this fork's
running server, not from the shim. The translated `READMEs/` were deleted rather than kept
stale — do not re-add translations without a way to keep them current.

## Current Stats (v0.9.29)

- 55 MCP tools (all visible by default, `AGENTMEMORY_TOOLS=core` for the 8 essentials)
- 132 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 11 hooks, 17 skills
- 260+ registered functions
- 1,850+ tests

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on this fork (`possiblyneal/agentmemory-sqlite`), driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. `CONTEXT.md` holds the glossary — use its terms in specs, issues, and commit messages. ADRs live in `docs/adrs/`; read any whose scope covers what you are touching before editing. See `docs/agents/domain.md`.

- [ADR 0001](./docs/adrs/0001-single-in-process-sqlite-engine.md) — this fork runs only the in-process SQLite Engine.
