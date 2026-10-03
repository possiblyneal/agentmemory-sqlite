const locks = new Map<string, Promise<void>>();

export function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.then(
    () => {},
    () => {},
  );
  locks.set(key, cleanup);
  cleanup.then(() => {
    if (locks.get(key) === cleanup) locks.delete(key);
  });
  return next;
}

// Locks are taken in sorted order so two overlapping batches cannot deadlock.
export function withKeyedLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  return [...keys]
    .sort()
    .reduceRight<() => Promise<T>>((inner, key) => () => withKeyedLock(key, inner), fn)();
}
