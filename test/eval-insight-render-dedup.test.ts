import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/insight-render-dedup.js";

it("renders equivalent Insights once without removing distinct qualifications or stored records", async () => {
  const result = await runExperiment();
  expect(result.baseline).toMatchObject({ delivered: 5, repeated: 2 });
  expect(result.treatment).toMatchObject({ delivered: 5, repeated: 0 });
  expect(result.baseline.tokens - result.treatment.tokens).toBeGreaterThanOrEqual(8);
  expect(result.storageChanged).toBe(false);
});
