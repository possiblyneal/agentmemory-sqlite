import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// A second full instance next to a live daemon races it for the REST,
// streams and viewer ports and leaves both half-bound. Two guards prevent
// that: unknown subcommands error instead of falling through to the server
// boot, and the boot path probes livez and refuses when a live daemon
// already answers on the resolved port.
describe("CLI second-instance guards (#1140)", () => {
  const src = readFileSync("src/cli.ts", "utf-8");

  it("unknown subcommands do not fall through to the server boot", () => {
    expect(src).toContain("async function unknownCommand()");
    expect(src).toMatch(
      /const handler = commands\[first\] \?\? \(first && !first\.startsWith\("-"\) \? unknownCommand : main\)/,
    );
  });

  it("main() probes livez and refuses to boot over a live daemon", () => {
    const mainBody = src.slice(src.indexOf("async function main()"));
    const probeIdx = mainBody.indexOf("/agentmemory/livez");
    expect(probeIdx).toBeGreaterThan(-1);
    // The probe must run before the daemon boot path.
    const bootIdx = mainBody.indexOf('await import("./index.js")');
    expect(probeIdx).toBeLessThan(bootIdx);
    expect(mainBody).toContain("already running on port");
  });
});
