import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/numbered-replies.js";

it("uses a selected option without changing ambiguous, unmatched or substantive replies", async () => {
  expect(await runExperiment()).toEqual({
    choices: 3, controls: 4, controlsChanged: 0,
    baseline: { useful: 3, rejected: 3 },
    treatment: { useful: 3, rejected: 0 },
  });
});
