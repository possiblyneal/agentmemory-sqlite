import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/condition-recall.js";

it("surfaces a still-applicable failure, but does not suppress a fix after its condition changes", async () => {
  const pairs = await runExperiment();
  expect(pairs.map(({ name, baseline, treatment }) => [name, baseline, treatment])).toEqual([
    ["persists", "stack", "wrap"], ["changed", "stack", "wrap"],
    ["known-match", "stack", "stack"], ["missing", "stack", "wrap"],
  ]);
});
