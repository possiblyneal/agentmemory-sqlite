// An export response is serialized whole and held in memory before it is
// written, so an unbounded one dies as a RangeError inside JSON.stringify or
// takes the daemon out on heap. The removed engine's 16 MiB WebSocket frame
// used to bound this as a side effect; nothing does now, so the export paths
// refuse an oversized payload as one clean 413 that names the narrowing
// options instead.
//
// The bound is far above any response a client should be asking for in one
// call and far below what serialization survives - it exists to turn a crash
// into an answer, not to ration exports.
export const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export type OversizedPayload = {
  success: false;
  error: string;
  oversized: true;
  /** Null when the payload could not be serialized to be measured at all. */
  bytes: number | null;
  limitBytes: number;
};

export function isOversizedPayload(value: unknown): value is OversizedPayload {
  return (value as OversizedPayload | null)?.oversized === true;
}

// `limitBytes` is overridable so a test can exercise the refusal without
// allocating a quarter of a gigabyte to trip the real bound.
export function checkPayloadSize(
  payload: unknown,
  hint: string,
  limitBytes: number = MAX_PAYLOAD_BYTES,
): OversizedPayload | null {
  let bytes: number | null;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  } catch {
    bytes = null;
  }
  if (bytes !== null && bytes <= limitBytes) return null;

  const size =
    bytes === null
      ? "too large to serialize"
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return {
    success: false,
    error: `Response is ${size}, over the ${limitBytes / (1024 * 1024)} MiB response limit; ${hint}`,
    oversized: true,
    bytes,
    limitBytes,
  };
}
