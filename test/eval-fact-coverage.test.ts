import { expect, it } from "vitest";
import { runExperiment } from "../eval/runner/fact-coverage.js";

it("compares paired first hits and retains the scope and no-match controls", async () => {
  const pairs = await runExperiment();
  expect(pairs.find(p => p.id === "specific")?.baseline).toBe("broad");
  expect(pairs.find(p => p.id === "specific")?.treatment).toBe("specific");
  expect(pairs.find(p => p.id === "risk")?.baseline).toBe("safe");
  expect(pairs.find(p => p.id === "risk")?.treatment).toBe("wrong");
  expect(pairs.find(p => p.id === "ambiguous")?.treatment).toBe("broad");
  expect(pairs.find(p => p.id === "no-match")?.baseline).toBeNull();
  expect(pairs.find(p => p.id === "no-match")?.treatment).toBeNull();
  expect(pairs.find(p => p.id === "scope")?.baseline).toBe("local");
  expect(pairs.find(p => p.id === "scope")?.treatment).toBe("local");
});
