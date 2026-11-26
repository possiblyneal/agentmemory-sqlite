import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/batch-split.js";

it("does not accept repeated or unknown IDs and measures extra delay from a failed split", async () => {
  const [recoverable, malformed, outage] = await runExperiment();
  expect([recoverable!.baseline.calls, recoverable!.treatment.calls]).toEqual([5, 3]);
  expect([malformed!.baseline.calls, malformed!.treatment.calls]).toEqual([5, 6]);
  expect(malformed!.delayed).toBeGreaterThan(0);
  expect(malformed!.treatment.misattributed).toBe(0);
  expect(outage!.baseline).toEqual(outage!.treatment);
});
