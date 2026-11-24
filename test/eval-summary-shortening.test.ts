import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/summary-shortening.js";

it("scores paired visible needs at session start", async () => {
  const result = await runExperiment();
  expect(result.controls.hiddenReference).toBe(true);
  expect(result.controls.noSummarySame).toBe(true);
  expect(result.controls.decisionOnlySame).toBe(true);
  expect(result.needs.decisions).toEqual({ total: 3, baseline: 2, treatment: 3, gained: 1, lost: 0 });
  expect(result.needs.files).toEqual({ total: 2, baseline: 1, treatment: 0, gained: 0, lost: 1 });
});
