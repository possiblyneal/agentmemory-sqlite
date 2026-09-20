# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

Use one of:

- **GitHub Security Advisories (only channel)** — private report form at <https://github.com/possiblyneal/agentmemory-sqlite/security/advisories/new>. GitHub routes the report to the Maintainers, assigns a GHSA identifier, and keeps you in a private thread until the fix ships. All sensitive details (stack traces, credentials, exploit payloads) stay end-to-end within GitHub's security infrastructure.

This fork publishes no security contact address. If the issue affects upstream `rohitg00/agentmemory` rather than code that diverges here, report it to <https://github.com/rohitg00/agentmemory/security/advisories/new> instead.

Include, at minimum:

- agentmemory version (`agentmemory --version`) and the commit you built from (`git rev-parse HEAD` in your clone).
- The affected surface — REST endpoint, MCP tool, hook, CLI flag, or filesystem layout.
- A minimal reproduction — prefer one curl invocation or one MCP tool call plus the environment state required.
- Impact, in your own words.

## What we do with it

1. **Acknowledge** within 72 hours (target: 24).
2. **Triage** — confirm reproduction, assign a severity using CVSS 3.1, and give you a rough timeline.
3. **Fix** in a private branch. Draft a GitHub Security Advisory with the patched version, CWE, CVSS vector, affected versions, and attribution to you (unless you prefer anonymity).
4. **Coordinate disclosure** — we agree a disclosure date with you. Default window is 30 days from acknowledgment for straightforward vulnerabilities, up to 90 days for ones that need a deep refactor.
5. **Publish** — merge and tag the patched version, publish the advisory, update `CHANGELOG.md` under a `### Security` section for the release. Nothing is published to npm; users update by pulling and rebuilding.

## Supported versions

| Version | Security fixes? |
|-|-|
| Latest minor (currently `0.9.x`) | Yes |
| Previous minor (currently `0.8.x`) | Critical / High severity only, for 90 days after a new minor is released |
| Older | No |

At v1.0 this policy switches to a stated LTS window per the roadmap.

## Scope

In scope:

- The server built from this repository (REST + MCP surface, hook handlers, state store).
- The standalone MCP server under `packages/mcp/`.
- The filesystem-watcher connector under `integrations/filesystem-watcher/`.
- First-party integrations under `integrations/` (`hermes/`, `openclaw/`, `filesystem-watcher/`).
- The Claude Code plugin under `plugin/`.

Out of scope:

- Third-party MCP clients consuming agentmemory — report to those projects.
- The marketing site under `website/` unless the issue affects user security (XSS against visitors, credential leak in build output).
- The `@agentmemory/*` packages on npm. This fork does not own or publish them; report those to upstream.

## Supply-chain stance

This fork is installed by cloning and building from source — there is no tarball and `dist/` is gitignored. The runtime dependency tree is intentionally small (7 production deps: `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@clack/prompts`, `dotenv`, `picocolors`, `ws`, `zod`) plus an optional set guarded behind `optionalDependencies` for embeddings. Storage is `node:sqlite` from the Node runtime itself, so the database is not a dependency at all.

**No lockfile is committed.** The reasoning:

- Pinning one would shift the supply-chain attack surface from "what npm resolves today" to "what was resolved when the lockfile was last regenerated," which is a different tradeoff, not strictly better.
- SemVer ranges (`^x.y.z`) on the deps mean security patches reach a rebuild without a re-release.

If you ship agentmemory inside a hardened pipeline that requires reproducible installs, the recommended path is:

1. `npm install --legacy-peer-deps` against a pinned clone in a controlled environment.
2. `npm shrinkwrap` to produce a versioned `npm-shrinkwrap.json` that travels with your deployment.
3. Audit `node_modules/` once at that point and rebuild internally.

CI runs a single `npm install --legacy-peer-deps --no-audit --no-fund` per job, so every test job resolves its own tree at run time.

Supply-chain monitoring we already do:

- Dependabot opens PRs for every minor/patch bump on the production dep list (visible in the open PRs).
- Every PR runs the full test suite on ubuntu-latest + macos-latest, Node 22 + 24 + 26, before any merge.
- `optionalDependencies` (`@huggingface/transformers`, transitively `onnxruntime-node`, etc.) are guarded by `try { await import("...") } catch` so a missing or compromised optional dep cannot break the core runtime path.

If you find a malicious package in our dep tree, file via the GHSA flow at the top of this document.

## Past advisories

This fork has published no advisories. Any it publishes will appear at <https://github.com/possiblyneal/agentmemory-sqlite/security/advisories>.

## Safe harbor

Good-faith research, reported privately, does not get legal heat from the project. Research targeting third-party deployments of agentmemory is not covered — that's between you and the deployer.
