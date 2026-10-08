import { TriggerAction, type ISdk } from "../engine/types.js";
import type { CompressedObservation, RawObservation, HookPayload, Origin, Session } from "../types.js";

const TOOL_HOOKS = new Set(["pre_tool_use", "post_tool_use", "post_tool_failure"]);
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { unlinkObservationNodes } from "../state/graph-indexes.js";
import { getSearchIndex, vectorIndexAddGuarded, isIndexExcluded, deleteIndexed } from "./search.js";
import { safeAudit } from "./audit.js";
import { decrementImageRef, deleteUnreferencedImage, incrementImageRef } from "./image-refs.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { recordProjectActivity } from "../state/project-time.js";
import { saveImageToDisk } from "../utils/image-store.js";
import { isHarnessMessage } from "../utils/harness-message.js";
import { isSqliteFull, unstoredOnFullDisk } from "./observe-retry.js";

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export async function storeSyntheticCompression(
  kv: StateKV,
  raw: RawObservation,
): Promise<CompressedObservation> {
  const synthetic = buildSyntheticCompression(raw);
  await kv.set(KV.observations(raw.sessionId), raw.id, synthetic);
  // Stored above unconditionally; only the INDEX writes are
  // skipped for excluded tools (retrieval echoes).
  if (!isIndexExcluded(synthetic)) {
    getSearchIndex().add(synthetic);
    await vectorIndexAddGuarded(
      synthetic.id,
      synthetic.sessionId,
      synthetic.title + " " + (synthetic.narrative || ""),
      { kind: "synthetic", logId: synthetic.id },
    );
  }
  return synthetic;
}

// Uncompressed rows carry no importance yet; rank them just below the
// default so a scored row of average value outlives an unscored one.
const UNSCORED_IMPORTANCE = 3;

// Every eviction is audited; the log names each capped Session once per
// process, since a long Session at its cap evicts on every tool call.
const capWarnedSessions = new Set<string>();

// A session at its cap still admits the newest observation: the work at the
// end of a long session is what a later one most often needs. The least
// important rows go first, oldest breaking ties (PR#1174).
async function evictOverCap(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
  cap: number,
  admittedId: string,
  pendingRefReleases: string[],
): Promise<number> {
  const scope = KV.observations(sessionId);
  const existing = await kv.list<{
    id: string;
    timestamp?: string;
    importance?: number;
    imageData?: string;
    imageRef?: string;
  }>(scope);
  const excess = existing.length - cap;
  if (excess <= 0) return 0;
  const victims = existing
    .filter((obs) => obs.id !== admittedId)
    .sort(
      (a, b) =>
        (a.importance ?? UNSCORED_IMPORTANCE) - (b.importance ?? UNSCORED_IMPORTANCE) ||
        (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
    )
    .slice(0, excess);
  let evicted = 0;
  for (const obs of victims) {
    try {
      await deleteIndexed(kv, scope, obs.id);
      await unlinkObservationNodes(kv, obs.id);
      evicted++;
    } catch (err) {
      logger.warn("Session cap eviction failed", {
        sessionId,
        obsId: obs.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // The row is gone, so it counts as evicted even if releasing its image
    // fails; a failed release is retried with the others.
    for (const filePath of new Set([obs.imageData, obs.imageRef].filter((p): p is string => !!p))) {
      await decrementImageRef(kv, sdk, filePath).catch((err) => {
        pendingRefReleases.push(filePath);
        logger.warn("Failed to release image of evicted observation", {
          sessionId,
          obsId: obs.id,
          imageRef: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    await safeAudit(kv, "delete", "mem::observe", [obs.id], {
      resource: "observation",
      reason: "session_observation_cap",
      sessionId,
    });
  }
  if (!capWarnedSessions.has(sessionId)) {
    capWarnedSessions.add(sessionId);
    logger.warn("Session observation cap reached; evicting least important from now on", {
      sessionId,
      cap,
      evicted,
    });
  }
  return evicted;
}

// Same lock and read-then-set as mem::observe's increment, so a concurrent
// observe cannot write back a count read before this decrement.
export async function lowerObservationCounts(
  kv: StateKV,
  removedBySession: Map<string, number>,
): Promise<void> {
  await Promise.all(
    [...removedBySession].map(([sessionId, removed]) =>
      withKeyedLock(`obs:${sessionId}`, async () => {
        const session = await kv.get<Session>(KV.sessions, sessionId);
        if (!session) return;
        await kv.update(KV.sessions, sessionId, [
          {
            type: "set",
            path: "observationCount",
            value: Math.max(0, (session.observationCount || 0) - removed),
          },
        ]);
      }).catch((err) => {
        logger.warn("Observation count update failed", {
          sessionId,
          removed,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );
}

function hasCompressibleContent(raw: RawObservation): boolean {
  return [raw.toolInput, raw.toolOutput, raw.userPrompt, raw.imageData].some(
    (v) =>
      v !== undefined &&
      v !== null &&
      v !== "" &&
      !(typeof v === "object" && Object.keys(v).length === 0),
  );
}

// Tools whose call only reads or lists: the synthetic record already holds the
// input and the head and tail of the output, so an LLM summary adds little that
// Recall needs.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "ToolSearch",
  "ListAgents",
  "TaskList",
  "TaskGet",
]);

const always = (): boolean => true;
const noneOf =
  (forbidden: RegExp) =>
  (args: string[]): boolean =>
    !args.some((a) => forbidden.test(a));

const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "rev-list",
  "merge-base",
  "cat-file",
  "grep",
]);

function isReadOnlyGit(args: string[]): boolean {
  let i = 0;
  while (args[i] === "--no-pager" || args[i] === "-C") i += args[i] === "-C" ? 2 : 1;
  const [sub, ...rest] = args.slice(i);
  if (rest.some((a) => a.startsWith("--output"))) return false;
  if (sub === "grep" && rest.some((a) => /^(-[a-zA-Z]*O|--op)/.test(a))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  if (sub === "branch") {
    return rest.every((a) =>
      /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--no-color|--color)$/.test(a),
    );
  }
  return false;
}

const READ_ONLY_COMMANDS: Record<string, (args: string[]) => boolean> = {
  cd: always,
  pwd: always,
  cat: always,
  echo: always,
  printf: always,
  grep: always,
  egrep: always,
  fgrep: always,
  rg: noneOf(/^--pre/),
  ls: always,
  tree: noneOf(/^(-[a-zA-Z]*[oR]|--o)/),
  head: always,
  tail: always,
  wc: always,
  jq: always,
  stat: always,
  file: noneOf(/^(-[a-zA-Z]*C|--c)/),
  diff: always,
  nl: always,
  cut: always,
  tr: always,
  basename: always,
  dirname: always,
  realpath: always,
  which: always,
  true: always,
  sort: noneOf(/^(-[a-zA-Z]*o|--o|--c)/),
  uniq: (args) =>
    !args.includes("--") && args.filter((a) => a === "-" || !a.startsWith("-")).length <= 1,
  find: noneOf(/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/),
  git: isReadOnlyGit,
};

function shellSegments(command: string): string[][] | null {
  const text = command.replace(/((\d|&)?>>?\s*\/dev\/null|\d?>&\d)(?=[\s;&|]|$)/g, " ");
  const segments: string[][] = [[]];
  let token = "";
  let quote: "'" | '"' | null = null;
  const endToken = () => {
    if (token) segments[segments.length - 1].push(token);
    token = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\") token += text[++i] ?? "";
      else if (quote === '"' && (c === "`" || (c === "$" && text[i + 1] === "("))) return null;
      else token += c;
      continue;
    }
    if (c === "\\") {
      token += text[++i] ?? "";
    } else if (c === "$" && text[i + 1] === "'") {
      return null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "`" || c === ">" || (c === "$" && text[i + 1] === "(") || (c === "<" && text[i + 1] === "(")) {
      return null;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
      endToken();
      segments.push([]);
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      token += c;
    }
  }
  if (quote) return null;
  endToken();
  return segments.filter((s) => s.length > 0);
}

function isReadOnlyCommand(command: string): boolean {
  const segments = shellSegments(command);
  if (!segments || segments.length === 0) return false;
  return segments.every(([name, ...args]) => {
    const base = name.replace(/^\/(usr\/)?bin\//, "");
    return Object.hasOwn(READ_ONLY_COMMANDS, base) && READ_ONLY_COMMANDS[base](args);
  });
}

function reportsError(output: unknown): boolean {
  if (typeof output === "string") {
    return /"stderr":\s*"[^"]|"interrupted":\s*true|"is_error":\s*true/.test(output);
  }
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return (typeof o["stderr"] === "string" && o["stderr"].trim() !== "") || o["interrupted"] === true || o["is_error"] === true;
}

export function isReadOnlyObservation(raw: RawObservation): boolean {
  if (raw.hookType !== "post_tool_use" || !raw.toolName) return false;
  if (reportsError(raw.toolOutput)) return false;
  if (READ_ONLY_TOOLS.has(raw.toolName)) return true;
  if (raw.toolName !== "Bash") return false;
  const command = (raw.toolInput as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && isReadOnlyCommand(command);
}

function promptOf(data: unknown): string {
  const prompt = (data as { prompt?: unknown } | null)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  // An image ref whose rollback or eviction release failed on a full disk;
  // retried on each later Observation until the disk has room. A restart
  // forgets it, as it does the disk-full queue.
  const pendingRefReleases: string[] = [];

  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      if (payload.hookType === "prompt_submit" && isHarnessMessage(promptOf(payload.data))) {
        return { skipped: true, reason: "harness-message", sessionId: payload.sessionId };
      }

      const obsId = generateId("obs");

      let dedupHash: string | undefined;
      if (dedupMap) {
        const dataIsObject =
          typeof payload.data === "object" && payload.data !== null;
        const d = dataIsObject
          ? (payload.data as Record<string, unknown>)
          : {};
        const toolName = (d["tool_name"] as string) || payload.hookType;
        // Hash the full payload when tool_input is absent so distinct
        // events never collapse onto one key.
        const dedupInput =
          d["tool_input"] !== undefined
            ? d["tool_input"]
            : dataIsObject
              ? d
              : payload.data;
        dedupHash = dedupMap.computeHash(
          payload.sessionId,
          toolName,
          dedupInput,
        );
        if (dedupMap.isDuplicate(dedupHash)) {
          return { deduplicated: true, sessionId: payload.sessionId };
        }
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      let originChannel: Origin["channel"] = "agent";
      if (payload.hookType === "prompt_submit") originChannel = "user";
      else if (TOOL_HOOKS.has(payload.hookType)) originChannel = "tool";
      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
        origin: {
          channel: originChannel,
          capturedAt: payload.timestamp,
        },
      };

      let extractedImage: string | undefined;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          raw.toolOutput = d["tool_output"] || d["error"];
          if (raw.origin && raw.toolName) raw.origin.detail = raw.toolName;
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }
        if (payload.hookType === "subagent_stop" && typeof d["last_message"] === "string") {
          raw.assistantResponse = d["last_message"];
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        // Existing session is the source of truth for agentId (even
        // undefined). Env AGENT_ID only fires when no session row
        // exists yet — otherwise an unscoped session would get
        // retroactively scoped by a later AGENT_ID export.
        const existingSession = await kv.get<{
          agentId?: string;
          observationCount?: number;
          firstPrompt?: string;
          status?: Session["status"];
          idleClosed?: boolean;
        }>(KV.sessions, payload.sessionId);
        const inheritedAgentId = existingSession
          ? existingSession.agentId
          : getAgentId();
        if (inheritedAgentId) {
          raw.agentId = inheritedAgentId;
        }

        // Before this Observation saves its image, so a retried rollback cannot
        // delete a file this Observation is about to reference. Another Session
        // saving the same image is not covered, as with eviction's decrements.
        for (const filePath of pendingRefReleases.splice(0)) {
          await decrementImageRef(kv, sdk, filePath).catch((err) => {
            pendingRefReleases.push(filePath);
            logger.warn("Image ref release retry failed", {
              imageRef: filePath,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        let imageBytesWritten = 0;
        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { filePath, bytesWritten } = await saveImageToDisk(pendingImageData).catch(
            (error: NodeJS.ErrnoException) => {
              throw error.code === "ENOSPC" ? unstoredOnFullDisk() : error;
            },
          );
          raw.imageData = filePath;
          imageBytesWritten = bytesWritten;
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        let heldImageRef: string | undefined;
        try {
          if (raw.imageData) {
            await incrementImageRef(kv, raw.imageData);
            heldImageRef = raw.imageData;
          }
          await kv.set(KV.observations(payload.sessionId), obsId, raw);
        } catch (error) {
          if (heldImageRef) {
            // decrementImageRef deletes the file only when no other observation
            // still references it (deduped images survive) and emits the
            // disk-size delta itself. A rollback that fails is retried later
            // rather than leaving the file referenced forever.
            try {
              await decrementImageRef(kv, sdk, heldImageRef);
            } catch (rollbackError) {
              pendingRefReleases.push(heldImageRef);
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: heldImageRef,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          } else if (raw.imageData && imageBytesWritten > 0) {
            await deleteUnreferencedImage(kv, sdk, raw.imageData).catch((err) => {
              logger.warn("Failed to delete image after observation write failure", {
                imageRef: raw.imageData,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
          if (isSqliteFull(error)) throw unstoredOnFullDisk();
          throw error;
        }

        // Evicting only after the row is stored means a write that fails on a
        // full disk, and each retry of it, costs the Session nothing.
        // The row is stored, so an eviction error must not fail the observe:
        // the hook would see a 500 and the Session's count would miss this row.
        const capEvicted =
          maxObservationsPerSession && maxObservationsPerSession > 0
            ? await evictOverCap(sdk, kv, payload.sessionId, maxObservationsPerSession, obsId, pendingRefReleases).catch(
                (err) => {
                  logger.warn("Session cap eviction failed", {
                    sessionId: payload.sessionId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  return 0;
                },
              )
            : 0;

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash);
        }

        await sdk.trigger({
          function_id: "stream::set",
          payload: {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: { type: "raw", observation: raw },
          },
        });

        await sdk.trigger({
          function_id: "stream::send",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            id: `raw-${obsId}`,
            type: "raw_observation",
            data: { type: "raw", observation: raw, sessionId: payload.sessionId },
          },
          action: TriggerAction.Void(),
        });

        const session = existingSession;
        if (session) {
          const updates: Array<{ type: "set" | "remove"; path: string; value?: unknown }> = [
            { type: "set", path: "updatedAt", value: new Date().toISOString() },
            {
              type: "set",
              path: "observationCount",
              value: Math.max(0, (session.observationCount || 0) - capEvicted) + 1,
            },
          ];
          if (!session.firstPrompt && typeof raw.userPrompt === "string") {
            const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
            if (trimmed.length > 0) {
              updates.push({
                type: "set",
                path: "firstPrompt",
                value: trimmed.slice(0, 200),
              });
            }
          }
          // Heal and the idle sweep close a Session that sat idle, and work may
          // resume in the same terminal with no SessionStart. A Session that
          // ended normally stays ended.
          if (session.status === "abandoned" || session.idleClosed) {
            updates.push(
              { type: "set", path: "status", value: "active" },
              { type: "remove", path: "endedAt" },
              { type: "remove", path: "idleClosed" },
            );
          }
          await kv.update(KV.sessions, payload.sessionId, updates);
        } else if (
          typeof payload.project === "string" &&
          payload.project.trim().length > 0 &&
          typeof payload.cwd === "string" &&
          payload.cwd.trim().length > 0
        ) {
          // A plugin that skips POST /session/start can fire observations before the session record exists. Without
          // an implicit create, those observations stack up but
          // `memory_sessions` never lists them, and summarize bails with
          // "Session not found for summarize". Create the session now from
          // the observation payload — but only when project + cwd are
          // present (HookPayload contract). Older test payloads without
          // those fields keep their original no-op behaviour.
          const trimmedPrompt =
            typeof raw.userPrompt === "string"
              ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
              : undefined;
          const ts = new Date().toISOString();
          const startedAt = payload.timestamp ?? ts;
          await kv.set(KV.sessions, payload.sessionId, {
            id: payload.sessionId,
            project: payload.project,
            cwd: payload.cwd,
            startedAt,
            updatedAt: ts,
            status: "active",
            observationCount: 1,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
            ...(trimmedPrompt && trimmedPrompt.length > 0
              ? { firstPrompt: trimmedPrompt }
              : {}),
          });
          await recordProjectActivity(kv, payload.project, startedAt);
        }

        // Per-observation LLM compression is opt-in as of 0.8.8.
        // Default path: build a zero-LLM synthetic compression so recall
        // and BM25 search still work without burning the user's Claude
        // token allocation on every tool invocation. With auto-compress on, a
        // read-only call stays synthetic too.
        const compressible = isAutoCompressEnabled() && hasCompressibleContent(raw);
        const readOnly = compressible && isReadOnlyObservation(raw);
        const llmCompress = compressible && !readOnly;
        if (llmCompress) {
          await sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
              raw,
            },
            action: TriggerAction.Void(),
          });
        } else {
          const synthetic = await storeSyntheticCompression(kv, raw);
          await sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(payload.sessionId),
              item_id: obsId,
              data: { type: "compressed", observation: synthetic },
            },
          });
          await sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              item_id: obsId,
              data: {
                type: "compressed",
                observation: synthetic,
                sessionId: payload.sessionId,
              },
            },
          });
        }

        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress: llmCompress ? "llm" : readOnly ? "read-only" : "synthetic",
        });
        return { observationId: obsId };
      });
    },
  );
}
