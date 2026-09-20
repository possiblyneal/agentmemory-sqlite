import { getMaxSourceObservationIds } from "../config.js";

// Provenance is evidence of origin, not a complete history. Source ids are
// appended in the order they are observed, so the newest live at the tail.
//
// Merges union the two sides, which can reintroduce an id already present.
// Deduping from the tail keeps that id at its newest position: deduping from
// the head would pin it to its first sighting and let the cap trim away the
// very evidence that arrived last. A duplicate-free run shorter than the cap
// comes back untouched, ids and order intact.
export function capSourceIds(ids: string[]): string[] {
  const max = getMaxSourceObservationIds();
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let i = ids.length - 1; i >= 0 && newestFirst.length < max; i--) {
    const id = ids[i];
    if (seen.has(id)) continue;
    seen.add(id);
    newestFirst.push(id);
  }
  return newestFirst.reverse();
}
