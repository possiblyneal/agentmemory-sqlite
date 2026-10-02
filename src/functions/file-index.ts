import type { ISdk } from "../engine/types.js";
import type { CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { recordAccessBatch } from "./access-tracker.js";
import { withFiles } from "./injections.js";
import { getSearchIndex } from "./search.js";
import { logger } from "../logger.js";

interface FileHistory {
  file: string;
  observations: Array<{
    sessionId: string;
    obsId: string;
    type: string;
    title: string;
    narrative: string;
    importance: number;
    timestamp: string;
    files: string[];
  }>;
}

export function registerFileIndexFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::file-context", 
    async (
      data: { sessionId?: string; files?: string[]; project?: string } | undefined,
    ) => {
      const sessionId =
        data && typeof data.sessionId === "string" ? data.sessionId.trim() : "";
      const normalizedProject =
        typeof data?.project === "string" ? data.project.trim() : undefined;
      const files = Array.isArray(data?.files)
        ? data!.files
            .map((file) => (typeof file === "string" ? file.trim() : ""))
            .filter(Boolean)
        : [];
      if (files.length === 0) {
        await recordAudit(kv, "observe", "mem::file-context", [sessionId || "unknown"], {
          error: "invalid_payload",
          hasSessionId: !!sessionId,
          hasProject: !!normalizedProject,
          fileCount: files.length,
        });
        return { context: "", files: [] };
      }
      const results: FileHistory[] = [];

      const sessions = await kv.list<Session>(KV.sessions);
      let otherSessions = sessionId
        ? sessions.filter((s) => s.id !== sessionId)
        : sessions;
      if (normalizedProject) {
        otherSessions = otherSessions.filter((s) => s.project === normalizedProject);
      }
      otherSessions = otherSessions
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .slice(0, 15);

      const sessionRank = new Map(otherSessions.map((s, i) => [s.id, i]));
      const normalizedFiles = files.map((file) => ({
        file,
        normalized: file.replace(/^\.\//, ""),
      }));
      const touches = (obsFiles: string[], file: string, normalized: string) =>
        obsFiles.some(
          (f) =>
            f === file ||
            f === normalized ||
            f.endsWith(`/${normalized}`) ||
            normalized.endsWith(`/${f}`),
        );

      const candidates = getSearchIndex()
        .withFilesIn(new Set(sessionRank.keys()))
        .filter((c) =>
          normalizedFiles.some(({ file, normalized }) => touches(c.files, file, normalized)),
        )
        .sort((a, b) => sessionRank.get(a.sessionId)! - sessionRank.get(b.sessionId)!);
      const observations = (
        await Promise.all(
          candidates.map(async (c) => ({
            sessionId: c.sessionId,
            obs: await kv.get<CompressedObservation>(KV.observations(c.sessionId), c.obsId),
          })),
        )
      ).filter(
        (r): r is { sessionId: string; obs: CompressedObservation } =>
          !!r.obs?.files && !!r.obs.title,
      );

      for (const { file, normalized } of normalizedFiles) {
        const history: FileHistory = { file, observations: [] };

        for (const { sessionId: ownerSessionId, obs } of observations) {
          if (touches(obs.files, file, normalized) && obs.importance >= 4) {
            history.observations.push({
              sessionId: ownerSessionId,
              obsId: obs.id,
              type: obs.type,
              title: obs.title,
              narrative: obs.narrative,
              importance: obs.importance,
              timestamp: obs.timestamp,
              files: obs.files,
            });
          }
        }

        history.observations.sort((a, b) => b.importance - a.importance);
        history.observations = history.observations.slice(0, 5);

        if (history.observations.length > 0) {
          results.push(history);
        }
      }

      if (results.length === 0) {
        return { context: "" };
      }

      const lines: string[] = ["<agentmemory-file-context>"];
      for (const fh of results) {
        lines.push(`## ${fh.file}`);
        for (const obs of fh.observations) {
          lines.push(`- [${obs.type}] ${obs.title}: ${obs.narrative}`);
        }
      }
      lines.push("</agentmemory-file-context>");

      const injected = results.flatMap((fh) =>
        fh.observations.map((obs) => withFiles({ kind: "observation", id: obs.obsId }, obs.files)),
      );
      void recordAccessBatch(kv, injected.map((ref) => ref.id));

      const context = lines.join("\n");
      logger.info("File context generated", {
        files: files.length,
        results: results.length,
      });
      return { context, injected };
    },
  );
}
