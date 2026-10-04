import { describe, expect, it } from "vitest";
import { withDefaultProject } from "../src/mcp/default-project.js";

describe("withDefaultProject", () => {
  it("fills project when a project-scoped tool omits it", () => {
    expect(withDefaultProject("memory_recall", { query: "x" }, "repo")).toEqual({
      query: "x",
      project: "repo",
    });
  });

  it("treats a blank project as omitted", () => {
    expect(withDefaultProject("memory_save", { content: "x", project: "  " }, "repo")).toEqual({
      content: "x",
      project: "repo",
    });
  });

  it("keeps an explicit project", () => {
    const args = { query: "x", project: "other" };
    expect(withDefaultProject("memory_recall", args, "repo")).toBe(args);
  });

  it("leaves global saves and global slots untouched", () => {
    const save = { content: "x", global: true };
    expect(withDefaultProject("memory_save", save, "repo")).toBe(save);
    const slot = { label: "l", scope: "global" };
    expect(withDefaultProject("memory_slot_create", slot, "repo")).toBe(slot);
  });

  it("leaves tools that take no project untouched", () => {
    const args = { limit: 5 };
    expect(withDefaultProject("memory_sessions", args, "repo")).toBe(args);
  });

  it("leaves memory_sketch_promote alone so the sketch keeps its own project", () => {
    const args = { sketchId: "s1" };
    expect(withDefaultProject("memory_sketch_promote", args, "repo")).toBe(args);
  });
});
