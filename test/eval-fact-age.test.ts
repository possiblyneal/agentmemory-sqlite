import { describe, expect, it } from "vitest";
import { runExperiment } from "../eval/runner/fact-age.js";

describe("queryless Fact age experiment", () => {
  it("compares page membership, reordering, stale risk and queried scope controls", async () => {
    const pairs = await runExperiment();
    expect(pairs).toEqual([
      { id: "durable", baseline: ["fresh"], treatment: ["durable"] },
      { id: "reorder", baseline: ["fresh", "durable"], treatment: ["durable", "fresh"] },
      { id: "stale", baseline: ["current"], treatment: ["current"] },
      { id: "query", baseline: ["durable", "fresh"], treatment: ["durable", "fresh"] },
      { id: "scope", baseline: ["local"], treatment: ["local"] },
    ]);
  });
});
