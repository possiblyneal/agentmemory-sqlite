import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/summary-gap-evidence.js";

it("bounds evidence from the failed interval and stops giving it after coverage recovers", async () => {
  const pairs = await runExperiment();
  expect(pairs.map(({ baseline, treatment }) => [baseline.before, treatment.before])).toEqual([["empty", "correct"], ["empty", "stale"], ["correct", "correct"]]);
  expect(pairs.every(({ baseline, treatment }) => !baseline.afterEvidence && !treatment.afterEvidence)).toBe(true);
});
