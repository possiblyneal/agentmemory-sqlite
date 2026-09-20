import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #640 + #474: the daemon records its pid in ~/.agentmemory/worker.pid so
// stop can reap it. Static check that src/index.ts writes the pidfile,
// src/cli.ts reads it in runStop, and both agree on the path.
describe("stop reaps the worker process (#640, #474)", () => {
  it("src/index.ts writes worker.pid on boot", () => {
    const source = readFileSync("src/index.ts", "utf-8");
    expect(source).toMatch(/workerPidfilePath\(\)/);
    expect(source).toMatch(/"worker\.pid"/);
    expect(source).toMatch(/writeWorkerPidfile\(\)/);
    expect(source).toMatch(/clearWorkerPidfile\(\)/);
  });

  it("src/cli.ts reads worker.pid in runStop and signals it on stop", () => {
    const source = readFileSync("src/cli.ts", "utf-8");
    expect(source).toMatch(/workerPidfilePath\(\)/);
    expect(source).toMatch(/"worker\.pid"/);
    expect(source).toMatch(/readWorkerPidfile\(\)/);
    expect(source).toMatch(/clearWorkerPidfile\(\)/);
    // Verify stop wiring: the pid read from the file is signaled, and the
    // pidfile is cleared afterwards.
    const stopBody = source.slice(source.indexOf("async function runStop()"));
    expect(stopBody).toMatch(/const workerPid = readWorkerPidfile\(\)/);
    expect(stopBody).toMatch(/stopWorkerPid\(workerPid, \d+\)/);
  });

  it("both files agree on the pidfile path: ~/.agentmemory/worker.pid", () => {
    const indexSrc = readFileSync("src/index.ts", "utf-8");
    const cliSrc = readFileSync("src/cli.ts", "utf-8");
    expect(indexSrc).toMatch(/\.agentmemory["'].*worker\.pid|"worker\.pid"/);
    expect(cliSrc).toMatch(/\.agentmemory["'].*worker\.pid|"worker\.pid"/);
  });
});
