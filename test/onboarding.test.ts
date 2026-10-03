import { describe, expect, it } from "vitest";

import { buildAgentOptions } from "../src/cli/onboarding.js";

describe("first-run onboarding", () => {
  it("offers Claude Code as the only setup target", () => {
    expect(buildAgentOptions()).toEqual([
      expect.objectContaining({
        value: "claude-code",
        label: expect.stringContaining("Claude Code"),
        hint: "native plugin",
      }),
    ]);
  });
});
