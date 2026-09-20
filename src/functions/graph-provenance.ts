import { getMaxSourceObservationIds } from "../config.js";

// Provenance is evidence of origin, not a complete history. Source ids are
// appended in the order they are observed, so the newest live at the tail and
// a tail slice is what survives the cap.
export function capSourceIds(ids: string[]): string[] {
  const max = getMaxSourceObservationIds();
  const unique = [...new Set(ids)];
  return unique.length > max ? unique.slice(unique.length - max) : unique;
}
