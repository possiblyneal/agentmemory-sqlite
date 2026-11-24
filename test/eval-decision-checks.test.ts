import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/decision-checks.js";

it("warns about grounded violations and declines to use an outdated check", async () => {
  const result = await runExperiment();
  expect(Object.fromEntries(result.pairs.map(pair => [pair.name, pair.advisories]))).toEqual({
    "wrong-page-size": ["page"], "right-page-size": [], "archive-change": ["archive"], "unrelated-change": [],
    "amended-correct": [], "amended-wrong": ["page"], "unsupported": [],
  });
  expect(result.staleCheckOutput).toEqual([]);
});
