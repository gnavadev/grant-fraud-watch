/**
 * Serialize async work with a minimum gap between starts (rate limiting).
 * Pass a number, or a function so the gap can change (e.g. after PRECALC=1 is set).
 */
export function createThrottle(
  minIntervalMs: number | (() => number),
): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = 0;

  return function throttle<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const gap =
        typeof minIntervalMs === "function"
          ? minIntervalMs()
          : minIntervalMs;
      const now = Date.now();
      const wait = Math.max(0, gap - (now - lastStart));
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      lastStart = Date.now();
      return fn();
    }) as Promise<T>;

    // Keep chain alive on errors so the queue continues
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
