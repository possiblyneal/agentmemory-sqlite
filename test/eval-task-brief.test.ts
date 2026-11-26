import { expect, it } from "vitest";
import { compileBrief } from "../eval/runner/task-brief.js";

it("keeps Rules and evidence and puts the task-specific decision ahead of the default", () => {
  const startup = "## Rules\n- Preserve the audit log.\n\n## Export\nEvidence: check the fixture.\nDecisions: Use mint for exports.; Use iris for nightly exports.";
  const submit = "- Use mint for exports.\n- Use iris for nightly exports.";
  const brief = compileBrief(startup, submit, "Which palette applies to nightly exports?");
  expect(brief).toContain("Preserve the audit log.");
  expect(brief).toContain("check the fixture.");
  expect(brief.match(/Use mint for exports\./g)).toHaveLength(1);
  expect(brief.indexOf("Use iris")).toBeLessThan(brief.indexOf("Use mint"));
});
