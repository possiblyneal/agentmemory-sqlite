// Lets queued I/O (/livez, hook requests) run before CPU-bound work continues.
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
