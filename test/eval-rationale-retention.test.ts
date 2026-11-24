import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/rationale-retention.js";

it("charges a checkout read when dropping a recoverable note, and does not invent missing rationale", () => {
  const result = runExperiment();
  expect(result.rows.find(row => row.name === "page-size")?.arms.map(arm => [arm.correct, arm.reads])).toEqual([[true, 1], [true, 0], [true, 1]]);
  expect(result.rows.find(row => row.name === "archive-format")?.arms.map(arm => arm.correct)).toEqual([false, true, true]);
  expect(result.rationaleBytes).toBeLessThan(result.fullBytes);
});
