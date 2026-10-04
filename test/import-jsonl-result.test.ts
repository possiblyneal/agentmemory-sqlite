import { describe, it, expect } from "vitest";
import { importZeroFilesMessage } from "../src/cli/import-jsonl-result.js";

describe("importZeroFilesMessage", () => {
  it("names the path that was searched", () => {
    expect(importZeroFilesMessage("/x/projects")).toContain("/x/projects");
  });
});
