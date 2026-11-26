import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/evidence-origins.js";

it("counts shared and unknown origins separately from verified independent evidence", async () => {
  const rows = await runExperiment();
  expect(rows.map(row => [row.name, row.baseline, row.treatment, row.unknown])).toEqual([
    ["copied-error", "amber", "jade", 0], ["corroborated", "jade", "jade", 0], ["incomplete", "jade", "amber", 2],
  ]);
});
