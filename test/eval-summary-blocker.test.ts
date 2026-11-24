import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/summary-blocker.js";

it("separates covered decisions from early Summary text and measures displaced retries", async () => {
  const pairs = await runExperiment();
  expect(pairs.map(({ baseline, treatment }) => [baseline.coverage, treatment.coverage])).toEqual([[15, 5], [25, 5], [35, 5]]);
  expect(pairs.every(({ baseline, treatment }) => baseline.timeouts === treatment.timeouts)).toBe(true);
  expect(pairs.some(({ baseline, treatment }) => treatment.backgroundMax > baseline.backgroundMax)).toBe(true);
});
