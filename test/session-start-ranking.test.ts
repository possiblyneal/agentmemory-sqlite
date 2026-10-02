import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

type ContextHandler = (data: {
  sessionId: string;
  project: string;
}) => Promise<{ context: string }>;

function wireContext(kv: ReturnType<typeof mockKV>): ContextHandler {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: (id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    },
  };
  registerContextFunction(sdk as never, kv as never, 4000);
  return handler!;
}

const session: Session = {
  id: "ses_past",
  project: "/p",
  cwd: "/p",
  startedAt: "2026-10-01T00:00:00.000Z",
  status: "completed",
  observationCount: 7,
};

function obs(n: number, importance: number): CompressedObservation {
  return {
    id: `obs_${n}`,
    sessionId: session.id,
    timestamp: `2026-10-01T00:0${n}:00.000Z`,
    type: "command_run",
    title: `step ${n}`,
    facts: [],
    narrative: `did step ${n}`,
    concepts: [],
    files: [],
    importance,
  };
}

describe("mem::context session-start Observations (#90)", () => {
  let kv: ReturnType<typeof mockKV>;
  let handler: ContextHandler;

  beforeEach(async () => {
    kv = mockKV();
    handler = wireContext(kv);
    await kv.set(KV.sessions, session.id, session);
  });

  async function shownSteps(observations: CompressedObservation[]): Promise<string[]> {
    for (const o of observations) await kv.set(KV.observations(session.id), o.id, o);
    const { context } = await handler({ sessionId: "ses_now", project: "/p" });
    return [...context.matchAll(/\] step (\d):/g)].map((m) => m[1]!);
  }

  it("shows the most recent Observations when every importance is the same", async () => {
    const steps = await shownSteps([1, 2, 3, 4, 5, 6, 7].map((n) => obs(n, 5)));

    expect(steps).toEqual(["7", "6", "5", "4", "3"]);
  });

  it("still shows a Session whose Observations all rate below 5", async () => {
    const steps = await shownSteps([1, 2].map((n) => obs(n, 3)));

    expect(steps).toEqual(["2", "1"]);
  });

  it("ranks by importance before recency", async () => {
    const steps = await shownSteps([obs(1, 9), obs(2, 4), obs(3, 6), obs(4, 6)]);

    expect(steps).toEqual(["1", "4", "3", "2"]);
  });
});
