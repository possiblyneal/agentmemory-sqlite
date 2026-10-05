import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("viewer Rebuild Graph", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");
  const rebuild = viewer.slice(
    viewer.indexOf("async function rebuildGraph()"),
    viewer.indexOf("function drawNodeShape"),
  );

  it("counts observations with a dry run before posting", () => {
    expect(rebuild).toMatch(/apiPost\('graph\/build', \{ dryRun: true \}\)/);
    expect(rebuild).toMatch(/preview\.observations/);
  });

  it("asks for confirmation before the real build", () => {
    expect(rebuild.indexOf("window.confirm(")).toBeGreaterThan(-1);
    expect(rebuild.indexOf("window.confirm(")).toBeLessThan(rebuild.indexOf("body: '{}'"));
  });

  it("ignores clicks and disables the button while a build runs", () => {
    expect(rebuild).toMatch(/state\.graph\.rebuild\.running\) return/);
    expect(viewer).toMatch(/rebuild\.running \? ' disabled' : ''/);
  });

  it("renders done, cancelled, refused and failed outcomes", () => {
    for (const text of ["Done:", "cancelled", "Refused:", "Build failed"]) {
      expect(rebuild).toContain(text);
    }
  });
});
