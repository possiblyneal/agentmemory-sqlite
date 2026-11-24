import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/gate-diversity.js";

it("measures both a rescued Session and a lost second hit in the same-sized Gate pool", async () => {
  const { crowded, second } = await runExperiment();
  expect(crowded).toMatchObject({ baseline: { visible: false }, treatment: { visible: true } });
  expect(second).toMatchObject({ baseline: { visible: true }, treatment: { visible: false } });
  for (const pair of [crowded, second]) {
    for (const arm of Object.values(pair)) {
      expect(arm.pool).toHaveLength(10);
      expect(arm.pool[9]).toContain("fixture-lesson");
      expect(arm.lessonVisible).toBe(true);
    }
  }
});
