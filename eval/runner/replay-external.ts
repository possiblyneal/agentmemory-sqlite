import { daemonCall } from "./daemon-http.js";
import { externalSessionId, type ExternalItem, type ExternalSource } from "./external-text.js";

const CONCURRENCY = 8;

interface StoredRow {
  id: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  facts?: string[];
  files?: string[];
}

export type ExternalIngest = "observe" | "commit-link";

export interface IngestedExternal {
  id: string;
  source: ExternalSource;
  project: string;
  sessionId: string;
  files: string[];
  row: StoredRow;
}

// Posts each item as a prompt-submit Observation, the shape a connector would
// send, timestamped when its text was final. One Session per (project, source),
// created implicitly by the first Observation. Returns each stored row with
// the item's own file list, which the synthetic record does not carry.
export async function ingestExternal(baseUrl: string, items: ExternalItem[], cwd: string): Promise<IngestedExternal[]> {
  const ids = new Map<ExternalItem, string>();
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      const { body } = await daemonCall<{ observationId?: string }>(baseUrl, "observe", {
        body: {
          hookType: "prompt_submit",
          sessionId: externalSessionId(item.project, item.source),
          project: item.project,
          cwd,
          timestamp: item.at,
          data: { prompt: item.text },
        },
      });
      if (body.observationId) ids.set(item, body.observationId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  const filesById = new Map([...ids].map(([item, id]) => [id, item]));
  const sessions = new Set(items.map((i) => externalSessionId(i.project, i.source)));
  const out: IngestedExternal[] = [];
  for (const sessionId of sessions) {
    const { body } = await daemonCall<{ observations?: StoredRow[] }>(baseUrl, `observations?sessionId=${encodeURIComponent(sessionId)}`);
    for (const row of body.observations ?? []) {
      const item = filesById.get(row.id);
      if (item) out.push({ id: row.id, source: item.source, project: item.project, sessionId, files: item.files, row });
    }
  }
  return out;
}

const FILES_MARKER = "\n\nFiles: ";

// The message of a corpus commit, whose text is `<message>\n\nFiles: <paths>`.
export function commitMessage(item: ExternalItem): string {
  const at = item.text.lastIndexOf(FILES_MARKER);
  return at < 0 ? item.text : item.text.slice(0, at);
}

// Links each commit through the daemon's commit-link path
// (POST /session/commit), the route the post-commit hook takes, so the stored
// row carries the daemon's own `files`, not the item's. A commit is dated by
// its committer date, as the corpus does, so the Session cutoff rule holds.
// Non-commit items are not part of this path and are skipped.
export async function ingestCommitLinks(baseUrl: string, items: ExternalItem[], cwd: string): Promise<IngestedExternal[]> {
  const commits = items.filter((i) => i.source === "commits");
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < commits.length; i = next++) {
      const item = commits[i];
      await daemonCall(baseUrl, "session/commit", {
        body: { sha: item.id, project: item.project, cwd, message: commitMessage(item), authoredAt: item.at, files: item.files },
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, commits.length) }, worker));

  const byId = new Map(commits.map((i) => [`obs_commit_${i.id}`, i]));
  const out: IngestedExternal[] = [];
  for (const project of new Set(commits.map((i) => i.project))) {
    const sessionId = `commits-${project}`;
    const { body } = await daemonCall<{ observations?: StoredRow[] }>(baseUrl, `observations?sessionId=${encodeURIComponent(sessionId)}`);
    for (const row of body.observations ?? []) {
      if (byId.has(row.id)) out.push({ id: row.id, source: "commits", project, sessionId, files: row.files ?? [], row });
    }
  }
  return out;
}
