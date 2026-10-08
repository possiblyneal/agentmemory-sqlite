import { TriggerAction, type ISdk } from "../engine/types.js";
import { readFileSync } from "node:fs";
import { isManagedImagePath } from "../utils/image-store.js";
import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
  MemoryProvider,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  COMPRESSION_SYSTEM,
  buildCompressionPrompt,
  truncate as truncateMiddleOut,
  TOOL_OUTPUT_MAX,
} from "../prompts/compression.js";
import { VISION_DESCRIPTION_PROMPT } from "../prompts/vision.js";
import { getXmlPayload, getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { getSearchIndex, vectorIndexAddGuarded, isIndexExcluded } from "./search.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { CompressOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreCompression } from "../eval/quality.js";
import { compressWithRetry } from "../eval/self-correct.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";
import { stripPrivateData } from "./privacy.js";

const VALID_TYPES = new Set<string>([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "image",
  "other",
]);

export const XML_PARSE_FAILED = "xml_parse_failed";

export type CompressionFields = Omit<CompressedObservation, "id" | "sessionId" | "timestamp">;

export interface CompressionJob {
  observationId: string;
  sessionId: string;
  raw: RawObservation;
}

function parseCompressionXml(response: string): CompressionFields | null {
  const xml = getXmlPayload(response, "observation");
  const rawType = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  if (!rawType || !title) return null;
  const type = VALID_TYPES.has(rawType) ? rawType : "other";

  return {
    type: type as ObservationType,
    title,
    subtitle: getXmlTag(xml, "subtitle") || undefined,
    facts: getXmlChildren(xml, "facts", "fact"),
    narrative: getXmlTag(xml, "narrative"),
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    importance: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "importance") || "5", 10) || 5),
    ),
  };
}

// One reply's verdict, shared by the single and batch paths so both accept
// exactly the same records.
export function checkCompression(
  response: string,
): { parsed: CompressionFields } | { errors: string[] } {
  const parsed = parseCompressionXml(response);
  if (!parsed) return { errors: [XML_PARSE_FAILED] };
  const result = validateOutput(CompressOutputSchema, parsed, "mem::compress");
  if (!result.valid) return { errors: result.result.errors };
  return { parsed };
}

// A failed compression must not leave an Observation outside both search
// legs, so it degrades to the zero-LLM synthetic record (confidence 0.3).
// The full raw is parked BEFORE the overwrite, so the re-compression sweep
// (api::recompress-orphans) works from the original and not from the
// synthetic's truncated narrative. attempts counts failures; the sweep
// quarantines a record that fails deterministically (e.g. content the model
// refuses to summarize) instead of cycling on it forever.
// This is a degradation, not a silent fallback: the caller still reports
// success:false and the error log still fires, so the alert still pages.
export async function storeDegradedCompression(
  kv: StateKV,
  job: CompressionJob,
  reason: string,
): Promise<void> {
  try {
    const prior = await kv.get<{ attempts?: number }>(KV.compressPending, job.observationId);
    await kv.set(KV.compressPending, job.observationId, {
      observationId: job.observationId,
      sessionId: job.sessionId,
      raw: job.raw,
      reason,
      failedAt: new Date().toISOString(),
      attempts: (prior?.attempts ?? 0) + 1,
    });

    const synthetic = buildSyntheticCompression(job.raw);
    synthetic.id = job.observationId;
    synthetic.sessionId = job.sessionId;
    await kv.set(KV.observations(job.sessionId), job.observationId, synthetic);
    if (!isIndexExcluded(synthetic)) {
      getSearchIndex().add(synthetic);
      await vectorIndexAddGuarded(
        synthetic.id,
        synthetic.sessionId,
        synthetic.title + " " + (synthetic.narrative || ""),
        { kind: "synthetic", logId: synthetic.id },
      );
    }
    logger.warn("Stored degraded synthetic observation after compression failure", {
      obsId: job.observationId,
      sessionId: job.sessionId,
      reason,
    });
  } catch (err) {
    // Nothing left to fall back to. Log loudly: this is the case where
    // an observation really is lost to retrieval.
    logger.error("Degraded store FAILED - observation is unretrievable", {
      obsId: job.observationId,
      sessionId: job.sessionId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Writes the LLM record over whatever the Observation held (raw or synthetic),
// clears its recovery entry, and re-indexes it: the BM25 add and the vector
// add both replace an existing id.
export async function commitCompression(
  sdk: ISdk,
  kv: StateKV,
  job: CompressionJob,
  parsed: CompressionFields,
  imageDescription?: string,
): Promise<{ compressed: CompressedObservation; qualityScore: number }> {
  const qualityScore = scoreCompression(parsed);
  const hasImage = job.raw.modality === "image" || job.raw.modality === "mixed";

  const compressed: CompressedObservation = {
    id: job.observationId,
    sessionId: job.sessionId,
    timestamp: job.raw.timestamp,
    ...parsed,
    confidence: qualityScore / 100,
    ...(hasImage ? { modality: job.raw.modality } : {}),
    ...(imageDescription ? { imageDescription } : {}),
    ...(job.raw.imageData ? { imageRef: job.raw.imageData } : {}),
    ...(job.raw.agentId ? { agentId: job.raw.agentId } : {}),
    ...(job.raw.origin ? { origin: job.raw.origin } : {}),
    // Persisted so the index-write sites can recognise the
    // daemon's own retrieval calls. Compression overwrites the raw
    // KV record, so without this the tool name is gone from disk.
    ...(job.raw.toolName ? { toolName: job.raw.toolName } : {}),
    // Full prompt text survives compression verbatim - the summary
    // above is derived from it, it does not replace it.
    ...(job.raw.userPrompt ? { userPrompt: job.raw.userPrompt } : {}),
    // The Agent's reply survives too: the Session Summary reads its tail.
    ...(job.raw.hookType === "stop" && job.raw.assistantResponse
      ? { assistantResponse: truncateMiddleOut(stripPrivateData(job.raw.assistantResponse), TOOL_OUTPUT_MAX) }
      : {}),
  };

  await kv.set(KV.observations(job.sessionId), job.observationId, compressed);

  // Clears a queued or failed Observation's recovery entry; a no-op for the rest.
  await kv.delete(KV.compressPending, job.observationId);

  // Stored above unconditionally; only the INDEX writes are
  // skipped for excluded tools (retrieval echoes).
  if (!isIndexExcluded(compressed)) {
    try {
      getSearchIndex().add(compressed);
    } catch (err) {
      logger.warn("Failed to index compressed observation into BM25", {
        obsId: compressed.id,
        sessionId: compressed.sessionId,
        title: compressed.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await vectorIndexAddGuarded(
      compressed.id,
      compressed.sessionId,
      compressed.title + " " + (compressed.narrative || ""),
      { kind: "observation", logId: compressed.id },
    );
  }

  const streamResults = await Promise.allSettled([
    sdk.trigger({
      function_id: "stream::send",
      payload: {
        stream_name: STREAM.name,
        group_id: STREAM.viewerGroup,
        id: `compressed-${job.observationId}`,
        type: "compressed_observation",
        data: {
          type: "compressed",
          observation: compressed,
          sessionId: job.sessionId,
        },
      },
      action: TriggerAction.Void(),
    }),
  ]);
  for (const result of streamResults) {
    if (result.status === "rejected") {
      logger.warn("Non-fatal stream publish failure after compress", {
        sessionId: job.sessionId,
        observationId: job.observationId,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  return { compressed, qualityScore };
}

export function registerCompressFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::compress",
    async (data: CompressionJob) => {
      const startMs = Date.now();

      let imageDescription: string | undefined;
      const hasImage = data.raw.modality === "image" || data.raw.modality === "mixed";

      if (hasImage && data.raw.imageData && provider.describeImage) {
        try {
          let base64Data = data.raw.imageData;
          let mimeType = "image/png";

          if (!data.raw.imageData.startsWith("/9j/") && !data.raw.imageData.startsWith("iVBOR")) {
            if (!isManagedImagePath(data.raw.imageData)) {
              throw new Error(`Refusing to read image outside managed store: ${data.raw.imageData}`);
            }
            const fileBuffer = readFileSync(data.raw.imageData);
            base64Data = fileBuffer.toString("base64");
            if (data.raw.imageData.endsWith(".jpg") || data.raw.imageData.endsWith(".jpeg")) mimeType = "image/jpeg";
            else if (data.raw.imageData.endsWith(".webp")) mimeType = "image/webp";
            else if (data.raw.imageData.endsWith(".gif")) mimeType = "image/gif";
          }

          imageDescription = stripPrivateData(
            await provider.describeImage(base64Data, mimeType, VISION_DESCRIPTION_PROMPT),
          );
          logger.info("Image described by vision model", { obsId: data.observationId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Vision model call failed, falling back to text-only compression", {
            obsId: data.observationId,
            error: msg,
          });
        }
      }

      const promptArgs = {
        hookType: data.raw.hookType,
        toolName: data.raw.toolName,
        toolInput: data.raw.toolInput,
        toolOutput: imageDescription
          ? `[Image Description]: ${imageDescription}\n\n${data.raw.toolOutput ?? ""}`
          : data.raw.toolOutput,
        userPrompt: data.raw.userPrompt,
        assistantResponse: data.raw.assistantResponse,
        timestamp: data.raw.timestamp,
      };
      const prompt = buildCompressionPrompt(promptArgs);

      try {
        let accepted: CompressionFields | null = null;
        const validator = (response: string) => {
          const verdict = checkCompression(response);
          if ("errors" in verdict) return { valid: false, errors: verdict.errors };
          accepted = verdict.parsed;
          return { valid: true };
        };

        const attempt = await compressWithRetry(
          provider,
          COMPRESSION_SYSTEM,
          prompt,
          validator,
          1,
          buildCompressionPrompt(promptArgs, { neutralize: true }),
        );

        if (attempt.response === null) {
          const reason = attempt.errors.includes(XML_PARSE_FAILED)
            ? "parse_failed"
            : "validation_failed";
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::compress", latencyMs, false);
          }
          logger.warn("Compression output rejected", {
            obsId: data.observationId,
            reason,
            errors: attempt.errors,
          });
          await storeDegradedCompression(kv, data, reason);
          return { success: false, error: reason };
        }

        const { compressed, qualityScore } = await commitCompression(
          sdk,
          kv,
          data,
          accepted!,
          imageDescription,
        );

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::compress",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Observation compressed", {
          obsId: data.observationId,
          type: compressed.type,
          importance: compressed.importance,
          qualityScore,
          retried: attempt.retried,
        });

        return { success: true, compressed, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::compress", latencyMs, false);
        }
        logger.error("Compression failed", {
          obsId: data.observationId,
          error: msg,
        });
        await storeDegradedCompression(kv, data, "compression_failed");
        return { success: false, error: "compression_failed" };
      }
    },
  );
}
