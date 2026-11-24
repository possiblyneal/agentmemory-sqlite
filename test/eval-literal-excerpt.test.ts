import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/literal-excerpt.js";

it("measures a literal excerpt's detail gains and lost surrounding decisions", async () => {
  expect(await runExperiment()).toMatchObject({ baseline: { details: 1, decisions: 3 }, treatment: { details: 3, decisions: 2 }, controlsChanged: 0 });
});
