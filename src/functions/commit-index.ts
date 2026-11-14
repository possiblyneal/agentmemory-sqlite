import type { CommitLink, CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";

const MAX_TEXT_CHARS = 4000;
const MAX_NARRATIVE_CHARS = 2000;

export function commitSessionId(project: string): string {
  return `commits-${project}`;
}

export function commitObservationId(sha: string): string {
  return `obs_commit_${sha}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// A commit's message and changed paths as one searchable Observation of the
// project's commits Session, so a commit made before any Session started is
// found by the paths it touched. The id comes from the sha, so linking a commit
// again replaces its row instead of adding one. Without a message or paths
// there is nothing to search and no row is written.
export async function indexCommitLink(
  kv: StateKV,
  link: CommitLink,
  project: string,
  cwd: string,
): Promise<boolean> {
  const message = link.message?.trim() ?? "";
  const files = link.files ?? [];
  if (!message && files.length === 0) return false;

  const sessionId = commitSessionId(project);
  const id = commitObservationId(link.sha);
  const timestamp = link.authoredAt ?? link.linkedAt;
  const text = (files.length > 0 ? `${message}\n\nFiles: ${files.join(", ")}` : message).slice(0, MAX_TEXT_CHARS);
  const observation: CompressedObservation = {
    id,
    sessionId,
    timestamp,
    type: "other",
    title: truncate(oneLine(message) || `Commit ${link.shortSha}`, 80),
    facts: [],
    narrative: truncate(text, MAX_NARRATIVE_CHARS),
    concepts: [],
    files,
    importance: 5,
    confidence: 0.3,
    userPrompt: text,
    origin: { channel: "import", detail: "commit", capturedAt: timestamp },
  };

  await withKeyedLock(`obs:${sessionId}`, async () => {
    const scope = KV.observations(sessionId);
    const existing = await kv.get(scope, id);
    await kv.set(scope, id, observation);
    const session = await kv.get<Session>(KV.sessions, sessionId);
    if (!session) {
      await kv.set(KV.sessions, sessionId, {
        id: sessionId,
        project,
        cwd,
        startedAt: timestamp,
        updatedAt: timestamp,
        endedAt: timestamp,
        status: "completed",
        observationCount: 1,
      } satisfies Session);
    } else if (!existing) {
      await kv.update(KV.sessions, sessionId, [
        { type: "set", path: "observationCount", value: (session.observationCount || 0) + 1 },
      ]);
    }
  });

  getSearchIndex().add(observation);
  await vectorIndexAddGuarded(id, sessionId, `${observation.title} ${observation.narrative}`, {
    kind: "synthetic",
    logId: id,
  });
  return true;
}
