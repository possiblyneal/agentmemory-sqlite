import { describe, it, expect } from "vitest";
import {
  getAllTools,
  PROJECT_NAME_DESCRIPTION,
  PROJECT_FILTER_DESCRIPTION,
} from "../src/mcp/tools-registry.js";

// rohitg00/agentmemory#1225: `project` was described only as "Filter by
// project", so the Agent skipped it or made one up.

const FILTER_TOOLS = [
  "memory_recall",
  "memory_smart_search",
  "memory_timeline",
  "memory_patterns",
  "memory_frontier",
  "memory_next",
  "memory_lesson_recall",
  "memory_reflect",
  "memory_insight_list",
];

function projectDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const tool of getAllTools()) {
    const prop = tool.inputSchema.properties["project"];
    if (prop) out.set(tool.name, prop.description);
  }
  return out;
}

describe("MCP project argument description", () => {
  it("names the main checkout basename and the injected project attribute", () => {
    expect(PROJECT_NAME_DESCRIPTION).toContain("main checkout");
    expect(PROJECT_NAME_DESCRIPTION).toContain('project="…"');
  });

  it("every project property carries the shared description", () => {
    const descriptions = projectDescriptions();
    expect(descriptions.size).toBeGreaterThan(FILTER_TOOLS.length);
    for (const [tool, description] of descriptions) {
      expect(description, tool).toContain(PROJECT_NAME_DESCRIPTION);
    }
  });

  it("filter tools say that leaving project out searches every project", () => {
    const descriptions = projectDescriptions();
    for (const tool of FILTER_TOOLS) {
      expect(descriptions.get(tool), tool).toBe(PROJECT_FILTER_DESCRIPTION);
    }
    for (const [tool, description] of descriptions) {
      if (!FILTER_TOOLS.includes(tool)) {
        expect(description, tool).not.toContain("every project");
      }
    }
  });
});
