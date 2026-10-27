import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { Session, SessionSummary } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const numbered = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("session-start Summary block is bounded", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
    registerContextFunction(sdk as never, kv as never, 100000);
  });

  async function start(overrides: Partial<SessionSummary>) {
    const s: Session = {
      id: "ses_old",
      project: "/p",
      cwd: "/p",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, s.id, s);
    await kv.set(KV.summaries, s.id, {
      sessionId: s.id,
      project: "/p",
      createdAt: s.startedAt,
      title: "t",
      narrative: "the narrative",
      keyDecisions: [],
      filesModified: [],
      concepts: [],
      observationCount: 1,
      ...overrides,
    } satisfies SessionSummary);
    return (await sdk.trigger("mem::context", { sessionId: "ses_now", project: "/p" })) as {
      context: string;
      injected: Array<{ kind: string; id: string; files?: string[] }>;
    };
  }

  it("renders only the first 10 of 12 decisions", async () => {
    const { context } = await start({ keyDecisions: numbered("d", 12) });
    expect(context).toContain("Decisions: d1; d2; d3; d4; d5; d6; d7; d8; d9; d10\n");
    expect(context).not.toContain("d11");
  });

  it("renders a Summary written before decisions were dated, from plain-string decisions", async () => {
    const { context } = await start({ keyDecisions: ["Fail closed when the token is unset"], decisionDates: undefined });
    expect(context).toContain("Decisions: Fail closed when the token is unset\n");
  });

  it("carries a 500-character decision whole", async () => {
    const { context } = await start({ keyDecisions: ["x".repeat(500)] });
    expect(context).toContain(`Decisions: ${"x".repeat(500)}\n`);
  });

  it("cuts a 700-character decision to its first 600 followed by an ellipsis", async () => {
    const { context } = await start({ keyDecisions: ["x".repeat(700)] });
    expect(context).toContain(`Decisions: ${"x".repeat(600)}…\n`);
    expect(context).not.toContain("x".repeat(601));
  });

  it("renders 10 of 15 files with a count of the rest, and the ref keeps all 15", async () => {
    const files = numbered("f", 15);
    const { context, injected } = await start({ filesModified: files });
    expect(context).toContain("Files: f1, f2, f3, f4, f5, f6, f7, f8, f9, f10 (+5 more)");
    expect(context).not.toContain("f11");
    expect(injected).toContainEqual({ kind: "summary", id: "ses_old", files });
  });

  it("shows no count for 10 or fewer files", async () => {
    const { context } = await start({ filesModified: numbered("f", 10) });
    expect(context).toContain("Files: f1, f2, f3, f4, f5, f6, f7, f8, f9, f10");
    expect(context).not.toContain("more)");
  });
});

describe("session-start Summary blocks are ordered by when the work happened", () => {
  async function order(summaries: Array<[string, Partial<SessionSummary>]>) {
    const kv = mockKV();
    const sdk = mockSdk();
    registerContextFunction(sdk as never, kv as never, 100000);
    for (const [id, extra] of summaries) {
      await kv.set(KV.sessions, id, {
        id,
        project: "/p",
        cwd: "/p",
        startedAt: "2026-10-01T00:00:00.000Z",
        status: "completed",
        observationCount: 1,
      } satisfies Session);
      await kv.set(KV.summaries, id, {
        sessionId: id,
        project: "/p",
        createdAt: "2026-10-20T00:00:00.000Z",
        title: `title-${id}`,
        narrative: "n",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 1,
        ...extra,
      } satisfies SessionSummary);
    }
    const { context } = (await sdk.trigger("mem::context", { sessionId: "ses_now", project: "/p" })) as {
      context: string;
    };
    return summaries
      .map(([id]) => [id, context.indexOf(`title-${id}`)] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  }

  it("falls back from lastObservationAt to coveredThrough to createdAt", async () => {
    expect(
      await order([
        ["created", { createdAt: "2026-10-05T00:00:00.000Z" }],
        ["covered", { createdAt: "2026-10-01T00:00:00.000Z", coveredThrough: "2026-10-06T00:00:00.000Z" }],
        [
          "worked",
          {
            createdAt: "2026-10-02T00:00:00.000Z",
            coveredThrough: "2026-10-03T00:00:00.000Z",
            lastObservationAt: "2026-10-07T00:00:00.000Z",
          },
        ],
      ]),
    ).toEqual(["worked", "covered", "created"]);
  });
});
