import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/superseded-lessons.js";

it("withholds only explicitly contradicted older same-project Lessons from visible Injection", async () => {
  expect(await runExperiment()).toEqual({
    cases: 6,
    baseline: { stale: 2, correct: 4 },
    treatment: { stale: 0, correct: 6 },
    controlsChanged: 0,
    storedLessonsChanged: 0,
  });
});
