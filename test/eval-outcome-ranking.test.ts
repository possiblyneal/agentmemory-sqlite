import { expect, it } from "vitest";
import { rankByOutcome, scoreAction } from "../eval/runner/outcome-ranking.js";

it("chooses based on dev outcomes, using Recall order when outcomes tie", () => {
  const ranked = [{ type: "file_edit" }, { type: "decision" }] as const;
  expect(rankByOutcome(ranked, [])).toEqual(ranked[0]);
  expect(rankByOutcome(ranked, [
    { type: "decision", success: true },
    { type: "decision", success: false },
    { type: "file_edit", success: false },
  ])).toEqual(ranked[1]);
});

it("scores valid actions and stale choices without knowing the arm", () => {
  expect(scoreAction('{"value":"iris"}', "iris", "mint")).toEqual({ success: true, stale: false });
  expect(scoreAction('{"value":"mint"}', "iris", "mint")).toEqual({ success: false, stale: true });
  expect(scoreAction('{"value":"iris","extra":true}', "iris", "mint")).toEqual({ success: false, stale: false });
});
