import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/fact-validity.js";

it("separates recorded and effective dates without guessing across gaps or conflicting intervals", async () => {
  const pairs = await runExperiment();
  expect(Object.fromEntries(pairs.map(row => [row.name, row.treatment]))).toEqual({
    historical: "original",
    current: "amended",
    boundary: "amended",
    future: "scheduled",
    unknown: "missing-dates",
    gap: "gap",
    overlap: "conflict",
    foreign: "no-evidence",
  });
  expect(pairs.find(row => row.name === "current")?.baseline).toBe("scheduled");
});
