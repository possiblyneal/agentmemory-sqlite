import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getAllTools,
  PROJECT_NAME_DESCRIPTION,
  PROJECT_FILTER_DESCRIPTION,
  PROJECT_OMITTED_CLAUSE,
} from "../src/mcp/tools-registry.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";

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

const SLOT_TOOLS = [
  "memory_slot_list",
  "memory_slot_get",
  "memory_slot_create",
  "memory_slot_append",
  "memory_slot_replace",
  "memory_slot_delete",
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
  it("names the injected project attribute first, then the main checkout default", () => {
    const attribute = PROJECT_NAME_DESCRIPTION.indexOf('project="…"');
    const basename = PROJECT_NAME_DESCRIPTION.indexOf("main checkout");
    expect(attribute).toBeGreaterThanOrEqual(0);
    expect(basename).toBeGreaterThan(attribute);
    expect(PROJECT_NAME_DESCRIPTION).toContain("AGENTMEMORY_PROJECT_NAME");
    expect(PROJECT_NAME_DESCRIPTION).toContain("Not a filesystem path");
  });

  it("every project property carries the shared description", () => {
    const descriptions = projectDescriptions();
    expect(descriptions.size).toBeGreaterThan(FILTER_TOOLS.length);
    for (const [tool, description] of descriptions) {
      expect(description, tool).toContain(PROJECT_NAME_DESCRIPTION);
    }
  });

  it("filter tools say that leaving project out uses the current project", () => {
    const descriptions = projectDescriptions();
    for (const tool of FILTER_TOOLS) {
      expect(descriptions.get(tool), tool).toBe(PROJECT_FILTER_DESCRIPTION);
    }
    for (const [tool, description] of descriptions) {
      if (!FILTER_TOOLS.includes(tool)) {
        expect(description, tool).not.toContain(PROJECT_OMITTED_CLAUSE);
      }
    }
  });

  it("slot tools carry the shared description exactly (rohitg00/agentmemory#1108)", () => {
    const descriptions = projectDescriptions();
    for (const tool of SLOT_TOOLS) {
      expect(descriptions.get(tool), tool).toBe(PROJECT_NAME_DESCRIPTION);
    }
  });

  it("the detect_patterns prompt's project argument is a filter", async () => {
    const handlers = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, handler: Function) => handlers.set(id, handler),
      registerTrigger: () => {},
      trigger: async () => null,
    };
    registerMcpEndpoints(sdk as never, {} as never);
    const result = (await handlers.get("mcp::prompts::list")!({ headers: {} })) as {
      body: { prompts: { name: string; arguments: { name: string; description: string }[] }[] };
    };
    const prompt = result.body.prompts.find((p) => p.name === "detect_patterns");
    const project = prompt?.arguments.find((a) => a.name === "project");
    expect(project?.description).toBe(PROJECT_FILTER_DESCRIPTION);
  });
});
