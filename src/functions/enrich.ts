import type { ISdk } from "../engine/types.js";
import type { InjectedRef, Memory } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { recordAccessBatch } from "./access-tracker.js";
import { estimateTokens } from "./context.js";
import { withFiles } from "./injections.js";

const MAX_CONTEXT_LENGTH = 4000;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function registerEnrichFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::enrich",
    async (data: {
      sessionId: string;
      files: string[];
      terms?: string[];
      toolName?: string;
      project?: string;
    }) => {
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;

      const parts: Array<{ text: string; injected: InjectedRef[] }> = [];

      const fileContextPromise = sdk
        .trigger<
          { sessionId: string; files: string[] },
          { context: string; injected?: InjectedRef[] }
        >({
          function_id: "mem::file-context",
          payload: {
            sessionId: data.sessionId,
            files: data.files,
          },
        })
        .catch((): { context: string; injected?: InjectedRef[] } => ({ context: "" }));

      const searchQueries: string[] = [
        ...data.files.map((f) => f.split("/").pop() || f),
        ...(data.terms || []),
      ].filter((q) => q.length > 0);

      const searchPromise =
        searchQueries.length > 0
          ? sdk
              .trigger<
                { query: string; limit: number; project?: string },
                { results: Array<{ observation: { id: string; narrative: string; files?: string[] } }> }
              >({
                function_id: "mem::search",
                payload: {
                  query: searchQueries.join(" "),
                  limit: 5,
                  ...(project !== undefined && { project }),
                },
              })
              .catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] });

      const bugMemoriesPromise = kv
        .list<Memory>(KV.memories)
        .then((memories) =>
          memories
            .filter(
              (m) =>
                m.type === "bug" &&
                m.isLatest &&
                // Guard only when both sides have an explicit project; unscoped memories pass through.
                (!project || !m.project || m.project === project) &&
                m.files.some((f) =>
                  data.files.some((df) => f.includes(df) || df.includes(f)),
                ),
            )
            .sort(
              (a, b) =>
                new Date(b.updatedAt || b.createdAt).getTime() -
                new Date(a.updatedAt || a.createdAt).getTime(),
            ),
        )
        .catch(() => []);

      const [fileContext, searchResult, bugMemories] = await Promise.all([
        fileContextPromise,
        searchPromise,
        bugMemoriesPromise,
      ]);

      if (fileContext.context) {
        parts.push({ text: fileContext.context, injected: fileContext.injected ?? [] });
      }

      const narrated = searchResult.results
        .map((r) => r.observation)
        .filter((o) => o?.narrative);
      if (narrated.length > 0) {
        const observations = narrated.map((o) => escapeXml(o.narrative)).join("\n");
        parts.push({
          text: `<agentmemory-relevant-context>\n${observations}\n</agentmemory-relevant-context>`,
          injected: narrated.map((o) => withFiles({ kind: "observation", id: o.id }, o.files)),
        });
      }

      if (bugMemories.length > 0) {
        const injected = bugMemories.slice(0, 3);
        void recordAccessBatch(kv, injected.map((m) => m.id));
        const bugs = injected
          .map((m) => `- ${escapeXml(m.title)}: ${escapeXml(m.content)}`)
          .join("\n");
        parts.push({
          text: `<agentmemory-past-errors>\n${bugs}\n</agentmemory-past-errors>`,
          injected: injected.map((m) => withFiles({ kind: "memory", id: m.id }, m.files)),
        });
      }

      const separator = "\n\n";
      const surviving: InjectedRef[] = [];
      let offset = 0;
      for (const part of parts) {
        if (offset < MAX_CONTEXT_LENGTH) surviving.push(...part.injected);
        offset += part.text.length + separator.length;
      }

      let context = parts.map((p) => p.text).join(separator);
      let truncated = false;
      if (context.length > MAX_CONTEXT_LENGTH) {
        context = context.slice(0, MAX_CONTEXT_LENGTH);
        truncated = true;
      }

      logger.info("Enrichment completed", {
        sessionId: data.sessionId,
        project,
        fileCount: data.files.length,
        contextLength: context.length,
        truncated,
      });

      return { context, truncated, tokens: estimateTokens(context), injected: surviving };
    },
  );
}
