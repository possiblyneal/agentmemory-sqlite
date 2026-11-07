import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAllTools } from "../src/mcp/tools-registry.js";
import { VERSION } from "../src/version.js";

const ROOT = join(import.meta.dirname, "..");

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

function countRestApiEndpoints(): number {
  const src = readText("src/triggers/api.ts");
  return Array.from(src.matchAll(/api_path:\s*["`]/g)).length;
}

function ledgerRows(markdown: string): string[][] {
  const section = markdown.split(/^## Ledger$/m)[1]?.split(/^## /m)[0] ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .replace(/^\||\|\s*$/g, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
}

function rowsMissingRetryIf(markdown: string): string[] {
  return ledgerRows(markdown)
    .filter(([, , , , , verdict, retryIf]) => /^(rejected|inconclusive)\b/.test(verdict) && (!retryIf || retryIf === "—"))
    .map(([date, hypothesis]) => `${date} ${hypothesis}`);
}

function scorecardsMissingFromLedger(markdown: string, scorecards: string[]): string[] {
  const section = markdown.split(/^## Ledger$/m)[1]?.split(/^## /m)[0] ?? "";
  return scorecards.filter((name) => !section.includes(`benchmarks/${name}`));
}

describe("Consistency checks", () => {
  const restEndpointCount = countRestApiEndpoints();

  it("version.ts matches package.json", () => {
    const pkg = JSON.parse(readText("package.json"));
    expect(VERSION).toBe(pkg.version);
  });

  it("plugin.json version matches package.json", () => {
    const pkg = JSON.parse(readText("package.json"));
    const plugin = JSON.parse(readText("plugin/.claude-plugin/plugin.json"));
    expect(plugin.version).toBe(pkg.version);
  });

  it("packages/mcp version matches package.json", () => {
    // The mcp package publishes in lockstep with the main package but its
    // version lives in its own manifest; without this guard a release bump
    // can silently ship a stale @agentmemory/mcp (it slipped in 0.9.29).
    const pkg = JSON.parse(readText("package.json"));
    const mcp = JSON.parse(readText("packages/mcp/package.json"));
    expect(mcp.version).toBe(pkg.version);
  });

  it("export-import.ts supports current version", () => {
    const src = readText("src/functions/export-import.ts");
    expect(src).toContain(`"${VERSION}"`);
  });

  it("documented REST endpoint counts match registered API paths", () => {
    const agents = readText("CLAUDE.md");
    const index = readText("src/index.ts");

    expect(restEndpointCount).toBeGreaterThan(0);
    expect(agents).toContain(`${restEndpointCount} REST endpoints`);
    expect(index).toContain(`REST API: ${restEndpointCount} endpoints`);
  });

  it("all tool names are unique", () => {
    const tools = getAllTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
  });

  it("Current Stats names the registered MCP tool count", () => {
    expect(readText("CLAUDE.md")).toContain(`- ${getAllTools().length} MCP tools`);
  });

  it("no tracked file tells a user to install from upstream's npm package", () => {
    const forbidden = [
      "npx @agentmemory/agentmemory",
      "npx -y @agentmemory/agentmemory",
      "npm install -g @agentmemory/",
    ];
    const exempt = (path: string) =>
      path === "CLAUDE.md" ||
      path === "test/consistency.test.ts" ||
      /^docs\/upstream-.*-triage\.yaml$/.test(path) ||
      path.startsWith("packages/mcp/");
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((path) => path && !exempt(path) && existsSync(join(ROOT, path)));
    const offenders = tracked.filter((path) => {
      const text = readText(path);
      return forbidden.some((phrase) => text.includes(phrase));
    });
    expect(offenders).toEqual([]);
  });

  it("all tools have name, description, and inputSchema", () => {
    for (const tool of getAllTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

});

describe("Experiment ledger", () => {
  const ledger = readText("docs/experiments.md");
  const scorecards = readdirSync(join(ROOT, "docs/benchmarks")).filter(
    (name) => name.endsWith(".md") && name !== "TEMPLATE.md",
  );

  it("links every scorecard from the ledger", () => {
    expect(scorecardsMissingFromLedger(ledger, scorecards)).toEqual([]);
  });

  it("names a Retry if on every rejected or inconclusive row", () => {
    expect(rowsMissingRetryIf(ledger)).toEqual([]);
  });

  it("flags a scorecard the ledger does not link", () => {
    expect(
      scorecardsMissingFromLedger(ledger, [...scorecards, "2099-01-01-unlisted.md"]),
    ).toEqual(["2099-01-01-unlisted.md"]);
  });

  it("flags rejected and inconclusive rows without a Retry if", () => {
    const fixture = [
      "## Ledger",
      "",
      "| Date | Hypothesis | Source | Eval | Result | Verdict | Retry if | Evidence |",
      "|---|---|---|---|---|---|---|---|",
      "| 2026-01-01 | kept one | — | e | r | kept | — | x |",
      "| 2026-01-02 | rejected, empty | — | e | r | rejected |  | x |",
      "| 2026-01-03 | rejected, dash | — | e | r | rejected | — | x |",
      "| 2026-01-04 | inconclusive, set | — | e | r | inconclusive | more items | x |",
      "",
      "## Candidate hypotheses",
      "",
      "| Hypothesis | Source |",
      "|---|---|",
      "| ignored | — |",
    ].join("\n");
    expect(rowsMissingRetryIf(fixture)).toEqual([
      "2026-01-02 rejected, empty",
      "2026-01-03 rejected, dash",
    ]);
  });
});
