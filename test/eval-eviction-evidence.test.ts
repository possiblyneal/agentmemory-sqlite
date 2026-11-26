import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/eviction-evidence.js";

it("compares project-cap victims at equal bytes without deleting uncovered evidence", async () => {
  const { scenarios } = await runExperiment();
  expect(scenarios).toHaveLength(2);
  for (const { baseline, treatment } of scenarios) {
    expect(baseline.bytes).toBe(treatment.bytes);
    for (const arm of [baseline, treatment]) {
      expect(arm.retained).toContain("guard");
      expect(arm.retained).toContain("fresh");
      expect(arm.deleted).toBe(1);
    }
  }
  expect(scenarios[0]).toMatchObject({ baseline: { answerable: false }, treatment: { answerable: true } });
  expect(scenarios[1]).toMatchObject({ baseline: { staleFirst: false }, treatment: { staleFirst: true } });
});
