import { describe, it, expect } from "vitest";
import { DedupMap } from "../src/functions/dedup.js";

describe("DedupMap.computeHash", () => {
  const map = new DedupMap();
  map.stop();
  const base = ["ses", "post_tool_use", "Bash", { command: "ls" }, "a.txt"] as const;

  it("is stable for identical arguments", () => {
    expect(map.computeHash(...base)).toBe(map.computeHash(...base));
  });

  it("differs when the output differs", () => {
    expect(map.computeHash(...base)).not.toBe(
      map.computeHash("ses", "post_tool_use", "Bash", { command: "ls" }, "b.txt"),
    );
  });

  it("differs when the hookType differs", () => {
    expect(map.computeHash(...base)).not.toBe(
      map.computeHash("ses", "post_tool_failure", "Bash", { command: "ls" }, "a.txt"),
    );
  });

  it("hashes the whole output, not a prefix", () => {
    const long = "x".repeat(2000);
    expect(map.computeHash("ses", "post_tool_use", "Bash", {}, long + "a")).not.toBe(
      map.computeHash("ses", "post_tool_use", "Bash", {}, long + "b"),
    );
  });
});
