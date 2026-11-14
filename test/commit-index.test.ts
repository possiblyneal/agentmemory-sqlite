import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { commitObservationId, commitSessionId } from "../src/functions/commit-index.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { CommitLink, CompressedObservation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const LINK = {
  sha: "aaa1111bbb",
  project: "api",
  cwd: "/repo",
  message: "Fix the retry loop in the uploader",
  authoredAt: "2026-10-01T00:00:00.000Z",
  files: ["src/upload/retry.ts", "test/upload.test.ts"],
};

describe("commit-link indexing", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  const link = (body: Record<string, unknown>) =>
    sdk.fns.get("api::session::commit")!({ headers: {}, body }) as Promise<{ status_code: number }>;

  beforeEach(() => {
    getSearchIndex().clear();
    sdk = mockSdk({ looseTrigger: true });
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, undefined);
  });

  it("stores a commit's message and changed paths as an Observation of the project's commits Session", async () => {
    expect((await link(LINK)).status_code).toBe(200);

    const obs = await kv.get<CompressedObservation>(KV.observations(commitSessionId("api")), commitObservationId(LINK.sha));
    expect(obs?.files).toEqual(LINK.files);
    expect(obs?.timestamp).toBe(LINK.authoredAt);
    expect(obs?.title).toBe(LINK.message);
    const session = await kv.get<Session>(KV.sessions, commitSessionId("api"));
    expect(session).toMatchObject({ project: "api", cwd: "/repo", status: "completed", observationCount: 1 });
  });

  it("makes the commit searchable by a path it touched and by its message", async () => {
    await link(LINK);

    const ids = (query: string) => getSearchIndex().search(query).map((h) => h.obsId);
    expect(ids("src/upload/retry.ts")).toContain(commitObservationId(LINK.sha));
    expect(ids("uploader retry")).toContain(commitObservationId(LINK.sha));
  });

  it("replaces the row when the same commit is linked again", async () => {
    await link(LINK);
    await link({ ...LINK, files: ["src/upload/retry.ts"] });

    const session = await kv.get<Session>(KV.sessions, commitSessionId("api"));
    expect(session?.observationCount).toBe(1);
    const obs = await kv.get<CompressedObservation>(KV.observations(commitSessionId("api")), commitObservationId(LINK.sha));
    expect(obs?.files).toEqual(["src/upload/retry.ts"]);
  });

  it("links without indexing when the body names no project and cwd", async () => {
    const { project: _p, cwd: _c, ...bare } = LINK;
    expect((await link(bare)).status_code).toBe(200);

    expect(await kv.get<CommitLink>(KV.commits, LINK.sha)).toMatchObject({ files: LINK.files });
    expect(await kv.get(KV.sessions, commitSessionId("api"))).toBeNull();
  });

  it("writes no row for a commit with neither message nor paths", async () => {
    await link({ sha: "ccc3333", project: "api", cwd: "/repo" });

    expect(await kv.get(KV.sessions, commitSessionId("api"))).toBeNull();
  });
});
