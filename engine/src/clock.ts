export interface Clock {
  now(): number;
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener("abort", done);
        clearTimeout(t);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
