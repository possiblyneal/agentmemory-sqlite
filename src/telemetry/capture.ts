let lastArrivalAt: string | null = null;
let lastStoredAt: string | null = null;

export function markCaptureArrival(): void {
  lastArrivalAt = new Date().toISOString();
}

export function markCaptureStored(): void {
  lastStoredAt = new Date().toISOString();
}

export function captureTimes(): { lastArrivalAt: string | null; lastStoredAt: string | null } {
  return { lastArrivalAt, lastStoredAt };
}

export function resetCaptureForTests(): void {
  lastArrivalAt = null;
  lastStoredAt = null;
}
