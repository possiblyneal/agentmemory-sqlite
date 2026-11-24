import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/clarification.js";

it("asks only about unresolved consequential choices and charges every interruption", async () => {
  const rows = await runExperiment();
  expect(rows.filter(row => row.asked).map(row => row.name)).toEqual(["costly-error", "costly-lucky"]);
  expect(rows.find(row => row.name === "amended")).toMatchObject({ baseline: "new", treatment: "new", asked: false });
  expect(rows.find(row => row.name === "costly-lucky")).toMatchObject({ baselineTime: 0, treatmentTime: 2 });
  expect(rows.find(row => row.name === "low-stakes")?.asked).toBe(false);
});
