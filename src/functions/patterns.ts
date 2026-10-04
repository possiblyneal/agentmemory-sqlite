import type { ISdk } from "../engine/types.js";
import type { CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { parseOptionalPositiveInt } from "../utils/parse-number.js";

interface Pattern {
  type: "co_change" | "error_repeat" | "workflow";
  description: string;
  files: string[];
  frequency: number;
  sessions: string[];
}

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;
const MAX_PAIRED_FILES_PER_SESSION = 50;

export const PATTERNS_LIMIT_ERROR = `limit must be an integer between 1 and ${MAX_SESSION_LIMIT}`;

export function parsePatternsLimit(value: unknown): number | undefined | null {
  const limit = parseOptionalPositiveInt(value);
  if (limit === undefined || limit === null) return limit;
  return limit <= MAX_SESSION_LIMIT ? limit : null;
}

export function registerPatternsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::patterns", 
    async (data: { project?: string; limit?: number }) => {
      const patterns: Pattern[] = [];

      const sessions = await kv.list<Session>(KV.sessions);
      const recentSessions = (
        data.project ? sessions.filter((s) => s.project === data.project) : sessions
      )
        .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
        .slice(0, data.limit ?? DEFAULT_SESSION_LIMIT);

      const fileCoOccurrences = new Map<string, number>();
      const fileSessionMap = new Map<string, Set<string>>();
      const errorPatterns = new Map<
        string,
        { count: number; sessions: Set<string> }
      >();

      // Bounded fan-out: load observations for up to 10 sessions in
      // parallel per batch (like consolidate), then fold each session's
      // observations into the shared maps serially so the accumulation
      // stays race-free. Parallelizing the kv.list I/O without exceeding
      // the invocation pool cuts wall time versus the old serial loop.
      for (let batch = 0; batch < recentSessions.length; batch += 10) {
        const chunk = recentSessions.slice(batch, batch + 10);
        const loaded = await Promise.all(
          chunk.map(async (session) => ({
            session,
            observations: await kv.list<CompressedObservation>(
              KV.observations(session.id),
            ),
          })),
        );

        for (const { session, observations } of loaded) {
          if (!observations.length) continue;

          const sessionFiles = new Set<string>();
          for (const obs of observations) {
            if (!obs.files) continue;
            for (const f of obs.files) sessionFiles.add(f);

            if (obs.type === "error" && obs.title) {
              const key = obs.title.toLowerCase();
              if (!errorPatterns.has(key)) {
                errorPatterns.set(key, { count: 0, sessions: new Set() });
              }
              const ep = errorPatterns.get(key)!;
              ep.count++;
              ep.sessions.add(session.id);
            }
          }

          const fileList = [...sessionFiles]
            .sort()
            .slice(0, MAX_PAIRED_FILES_PER_SESSION);
          for (const f of fileList) {
            if (!fileSessionMap.has(f)) fileSessionMap.set(f, new Set());
            fileSessionMap.get(f)!.add(session.id);
          }
          for (let i = 0; i < fileList.length; i++) {
            for (let j = i + 1; j < fileList.length; j++) {
              const pair = `${fileList[i]}::${fileList[j]}`;
              fileCoOccurrences.set(
                pair,
                (fileCoOccurrences.get(pair) || 0) + 1,
              );
            }
          }
        }
      }

      for (const [pair, count] of fileCoOccurrences) {
        if (count < 3) continue;
        const [fileA, fileB] = pair.split("::");
        const sessionsA = fileSessionMap.get(fileA) || new Set();
        const sessionsB = fileSessionMap.get(fileB) || new Set();
        const commonSessions = [...sessionsA].filter((s) => sessionsB.has(s));

        patterns.push({
          type: "co_change",
          description: `${fileA} and ${fileB} are frequently modified together`,
          files: [fileA, fileB],
          frequency: count,
          sessions: commonSessions,
        });
      }

      for (const [
        errorKey,
        { count, sessions: errorSessions },
      ] of errorPatterns) {
        if (count < 2) continue;
        patterns.push({
          type: "error_repeat",
          description: `Recurring error: ${errorKey}`,
          files: [],
          frequency: count,
          sessions: [...errorSessions],
        });
      }

      patterns.sort((a, b) => b.frequency - a.frequency);

      logger.info("Pattern detection complete", {
        patterns: patterns.length,
        sessions: recentSessions.length,
      });

      return { patterns: patterns.slice(0, 20) };
    },
  );

  sdk.registerFunction("mem::generate-rules", 
    async (data: { project?: string }) => {
      const result = await sdk.trigger<
        { project?: string },
        { patterns: Pattern[] }
      >({ function_id: "mem::patterns", payload: data });

      const rules: string[] = [];

      for (const pattern of result.patterns) {
        if (pattern.type === "co_change" && pattern.frequency >= 4) {
          rules.push(
            `When modifying ${pattern.files[0]}, also check ${pattern.files[1]} (co-changed ${pattern.frequency} times).`,
          );
        }
        if (pattern.type === "error_repeat" && pattern.frequency >= 3) {
          rules.push(
            `Watch for: ${pattern.description} (occurred ${pattern.frequency} times across ${pattern.sessions.length} sessions).`,
          );
        }
      }

      logger.info("Rules generated", { count: rules.length });
      return { rules };
    },
  );
}
