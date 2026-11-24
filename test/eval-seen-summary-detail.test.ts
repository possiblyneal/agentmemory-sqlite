import { describe, expect, it } from "vitest";
import { runExperiment } from "../eval/runner/seen-summary-detail.js";

describe("seen Summary exact detail experiment", () => {
  it("compares novel delivery, visible and repeat controls, and wrong-condition risk", async () => {
    const results = await runExperiment();
    expect(results).toMatchObject({ baseline: { needed: 1, wrong: 0, repeat: 0 }, treatment: { needed: 2, wrong: 1, repeat: 0 } });
  });
});
