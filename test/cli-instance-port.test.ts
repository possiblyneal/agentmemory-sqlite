import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_INSTANCE, resolveInstancePort } from "../src/cli/instance-port.js";

describe("resolveInstancePort (#405)", () => {
  it("maps instances to 100-port blocks off 3111", () => {
    expect(resolveInstancePort("0")).toEqual({ ok: true, restPort: 3111 });
    expect(resolveInstancePort("1")).toEqual({ ok: true, restPort: 3211 });
    expect(resolveInstancePort("60")).toEqual({ ok: true, restPort: 9111 });
  });

  it("accepts the last instance whose block stays under 65535", () => {
    expect(MAX_INSTANCE).toBe(624);
    expect(resolveInstancePort("624")).toEqual({ ok: true, restPort: 65511 });
  });

  it.each(["625", "99999", "-1", "abc", "1.5", "", "1e2", " 3", "0x10"])(
    "rejects %j rather than falling back to 3111",
    (value) => {
      const r = resolveInstancePort(value);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("0 to 624");
    },
  );

  it("rejects a missing value", () => {
    expect(resolveInstancePort(undefined).ok).toBe(false);
  });
});

describe("cli.ts --instance handling (#405)", () => {
  it("exits non-zero on an invalid value instead of ignoring it", () => {
    const src = readFileSync("src/cli.ts", "utf-8");
    const block = src.slice(src.indexOf('args.indexOf("--instance")'));
    expect(block.slice(0, 500)).toMatch(/resolveInstancePort[\s\S]*process\.exit\(1\)/);
  });
});
