import { expect, it } from "vitest";
import { retainApprovals } from "../eval/runner/history-omissions.js";

it("retains confirmed decisions but never proposals, foreign history or future amendments", () => {
  expect(retainApprovals([
    { at: 1, project: "local", kind: "proposal", text: "Use coral" },
    { at: 2, project: "local", kind: "approval", text: "Use indigo" },
    { at: 3, project: "other", kind: "approval", text: "Use plum" },
    { at: 5, project: "local", kind: "approval", text: "Use amber" },
  ], "local", 4)).toBe("Use indigo");
});
