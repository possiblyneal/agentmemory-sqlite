import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/path-floor.js";

it("measures exact-path help without hiding the Gate's fail-open outcome", async () => {
  const pairs = await runExperiment();
  expect(pairs.map(({ baseline }) => baseline)).toEqual(["empty", "empty", "empty", "empty", "empty", "empty"]);
  expect(pairs.map(({ treatment }) => treatment)).toEqual(["needed", "needed", "empty", "empty", "empty", "irrelevant"]);
  expect(pairs.map(({ requests }) => requests)).toEqual([1, 1, 1, 0, 0, 1]);
});
