import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/outcome-review.js";

it("publishes the verified correction, not a rewrite from a conflicting outcome", async () => {
  const { cases } = await runExperiment();
  expect(cases.map(({ flag, changed }) => [flag, changed])).toEqual([[true, true], [true, false], [false, false]]);
  expect(cases[0]?.baselineCorrect).toBe(false);
  expect(cases[0]?.treatmentCorrect).toBe(true);
  expect(cases.every(({ untouched }) => untouched)).toBe(true);
});
