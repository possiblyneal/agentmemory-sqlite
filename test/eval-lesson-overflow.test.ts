import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/lesson-overflow.js";

it("compares complete visible Lessons under final budget pressure", async () => {
  const result = await runExperiment();
  expect(result.pressure.baseline).not.toContain("short amber instruction");
  expect(result.pressure.treatment).toContain("short amber instruction");
  expect(result.pressure.treatment).not.toContain("long violet instruction");
  expect(result.control.baseline).toBe(result.control.treatment);
  for (const pair of [result.pressure, result.control, result.counterexample]) {
    expect(pair.baseline).toContain("preserve the cobalt rule");
    expect(pair.treatment).toContain("preserve the cobalt rule");
    expect(pair.baselineTokens).toBeLessThanOrEqual(180);
    expect(pair.treatmentTokens).toBeLessThanOrEqual(180);
  }
  expect(result.prefix.baseline).toContain("preserve the cobalt rule");
  expect(result.prefix.baselineTokens).toBeLessThanOrEqual(300);
  expect(result.prefix.treatmentTokens).toBeLessThanOrEqual(300);
  expect(result.prefix.baseline).toContain("first small instruction");
  expect(result.prefix.baseline).not.toContain("last small instruction");
  expect(result.prefix.treatment).toBe(result.prefix.baseline);
  expect(result.counterexample.baseline).toContain("needed observation content");
  expect(result.counterexample.treatment).not.toContain("needed observation content");
});
