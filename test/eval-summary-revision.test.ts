import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/summary-revision.js";

it("reinjects changed visible decisions once and leaves controls unchanged", async () => {
  const pairs = await runExperiment();
  expect(pairs.map(({ baseline, treatment }) => [baseline.stale, treatment.stale])).toEqual([[true, false], [false, false], [false, false], [false, false]]);
  expect(pairs.map(({ treatment }) => treatment.secondTokens > 0)).toEqual([true, false, false, false]);
  expect(pairs.every(({ baseline, treatment }) => baseline.thirdTokens === 0 && treatment.thirdTokens === 0)).toBe(true);
});
