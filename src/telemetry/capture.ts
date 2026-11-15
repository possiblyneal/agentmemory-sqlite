let lastArrivalAt: string | null = null;
let lastStoredAt: string | null = null;
const pendingSince = new Map<object, string>();

export function markCaptureArrival(observation: object): void {
  lastArrivalAt = new Date().toISOString();
  pendingSince.set(observation, lastArrivalAt);
}

export function markCaptureStored(): void {
  lastStoredAt = new Date().toISOString();
}

export function markCaptureSettled(observation: object): void {
  pendingSince.delete(observation);
}

export function captureTimes(): {
  lastArrivalAt: string | null;
  lastStoredAt: string | null;
  oldestPendingAt: string | null;
} {
  const oldestPendingAt = pendingSince.values().next().value ?? null;
  return { lastArrivalAt, lastStoredAt, oldestPendingAt };
}

export function resetCaptureForTests(): void {
  lastArrivalAt = null;
  lastStoredAt = null;
  pendingSince.clear();
}
