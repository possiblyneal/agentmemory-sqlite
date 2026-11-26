import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/amendment-deadline.js";

it("counts a timely stale rule as a regression rather than a timeout win", async () => {
  expect(await runExperiment()).toEqual({
    baseline: { timelyCorrect: 2, stale: 0, missed: 2 },
    treatment: { timelyCorrect: 3, stale: 1, missed: 0 },
    skipped: 2,
  });
});
