import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/fact-conditions.js";

it("promotes the exact conditional Fact while preserving unqualified results and storage", async () => {
  const { trials, storageUnchanged } = await runExperiment();
  for (const trial of trials) {
    if (trial.wanted) expect(trial.treatment[0]).toBe(trial.wanted);
    else expect(trial.treatment).toEqual(trial.baseline);
    expect([...trial.treatment].sort()).toEqual([...trial.baseline].sort());
    expect(trial.treatment).not.toContain("foreign");
  }
  expect(trials.some((trial) => trial.wanted && trial.baseline[0] !== trial.wanted)).toBe(true);
  expect(storageUnchanged).toBe(true);
});
