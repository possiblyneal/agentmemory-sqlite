import { expect, it } from "vitest";
import { reconstruct } from "../eval/runner/working-state.js";

it("treats a passed check before the last edit as stale and an edit plan as inferred", () => {
  const state = reconstruct([
    { kind: "goal", text: "Update the palette" },
    { kind: "check", revision: "old", passed: true },
    { kind: "edit", revision: "new" },
    { kind: "plan", text: "Maybe add another fixture" },
  ]);
  expect(state.observed).toEqual({ revision: "new", checkCurrent: false });
  expect(state.inferred).toEqual({ next: "verify", pending: ["Maybe add another fixture"] });
});
