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
