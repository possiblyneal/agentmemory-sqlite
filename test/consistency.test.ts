import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
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

  it("all tools have name, description, and inputSchema", () => {
    for (const tool of getAllTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

});
