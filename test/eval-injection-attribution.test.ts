import { expect, it } from "vitest";
import { learnPolicy } from "../eval/runner/injection-attribution.js";

it("withholds only when paired development outcomes favor withholding", () => {
  const training = [
    { kind: "rule", included: true, success: true },
    { kind: "rule", included: false, success: false },
    { kind: "legacy", included: true, success: false },
    { kind: "legacy", included: false, success: true },
  ];
  expect(learnPolicy(training, "rule")).toBe(true);
  expect(learnPolicy(training, "legacy")).toBe(false);
  expect(learnPolicy(training, "unknown")).toBe(true);
});
