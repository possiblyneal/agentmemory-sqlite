import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/budget-allocation.js";

it("rejects an aggregate gain that costs a startup delivery", () => {
  const { learned, pairs } = runExperiment();
  expect(learned).toBe(2);
  expect(pairs[0]?.baseline.correct).toEqual({ startup: 1, prompt: 0 });
  expect(pairs[0]?.treatment.correct).toEqual({ startup: 0, prompt: 2 });
  expect(pairs[0]?.treatment.foreign).toBe(false);
});
