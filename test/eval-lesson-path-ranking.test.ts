import { describe, expect, it } from "vitest";
import { rankPair } from "../eval/runner/lesson-path-ranking.js";

describe("exact-file Lesson ranking experiment", () => {
  it("prefers a matching file over an unrelated directory result", async () => {
    const pair = await rankPair("win");
    expect(pair.control).toEqual(["directory"]);
    expect(pair.treatment).toEqual(["exact"]);
  });

  it("exposes when an exact file displaces needed directory guidance", async () => {
    const pair = await rankPair("directory-needed");
    expect(pair.control).toEqual(["guidance"]);
    expect(pair.treatment).toEqual(["exact"]);
  });

  it("leaves an unknown task path unchanged and excludes another project", async () => {
    const pair = await rankPair("no-path");
    expect(pair.control).toEqual(["directory"]);
    expect(pair.treatment).toEqual(pair.control);
    expect(pair.pool).not.toContain("foreign");
  });

  it("does not treat a path with extra components as the exact file", async () => {
    const pair = await rankPair("different-path");
    expect(pair.control).toEqual(["directory"]);
    expect(pair.treatment).toEqual(pair.control);
  });
});
