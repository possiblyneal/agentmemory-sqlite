import { expect, it } from "vitest";
import { attachEvidence, scoreClaimAction } from "../eval/runner/claim-evidence.js";

it("exposes a missing source without turning uncertainty into a verified claim", async () => {
  const summary = "Requirements the user settled:\n- Set palette mint.";
  const result = await attachEvidence(summary, [{ text: "Set palette mint.", status: "uncertain", id: "missing" }], async () => null);
  expect(result).toBe(`${summary} [uncertain; source unavailable (missing)]`);
  expect(scoreClaimAction('{"value":"mint"}', "defer", ["mint"])).toEqual({ correct: false, unsafe: true });
});
