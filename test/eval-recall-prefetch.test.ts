import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/recall-prefetch.js";

it("uses only ready matching candidates and accounts for contention and discarded prefetches", () => {
  const { baseline, prefetch } = runExperiment();
  expect(baseline.prompts.find(row => row.id === "busy-a")?.timely).toBe(false);
  expect(prefetch.prompts.find(row => row.id === "busy-a")).toMatchObject({ reused: true, timely: true });
  expect(prefetch.prompts.find(row => row.id === "busy-b")).toMatchObject({ reused: false, timely: false });
  expect(prefetch.prompts.filter(row => row.reused).map(row => row.id)).toEqual(["busy-a", "quiet"]);
  expect(prefetch.discarded).toBe(3);
});
