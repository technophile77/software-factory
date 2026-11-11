import type { Clock } from "../harness";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** A clock that moves only when a test advances it. */
export class FakeClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start = Date.parse("2026-11-11T09:00:00Z")) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** Resolves after `ms` of fake time, or early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const id = this.setTimeout(done, ms);
      const self = this;
      function done() {
        signal?.removeEventListener("abort", done);
        self.clearTimeout(id);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Moves time forward, firing due timers in order and letting real I/O run
   * between them. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await realTicks();
    }
    this.t = end;
    await realTicks();
  }
}

export async function realTicks(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

export const realDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Advances the clock in steps until `p` settles: for calls that wait on the
 * engine's clock (device-flow polling, `wait_s`). */
export async function drive<T>(
  clock: FakeClock,
  p: Promise<T>,
  opts: { stepMs?: number; maxMs?: number; realMs?: number } = {},
): Promise<T> {
  const stepMs = opts.stepMs ?? 1000;
  const maxMs = opts.maxMs ?? 1_000_000;
  const realMs = opts.realMs ?? 5;
  let settled = false;
  const watched = p.finally(() => {
    settled = true;
  });
  watched.catch(() => undefined);
  let moved = 0;
  while (!settled && moved <= maxMs) {
    await realDelay(realMs);
    if (settled) break;
    await clock.advance(stepMs);
    moved += stepMs;
  }
  if (!settled) throw new Error(`did not settle after advancing the clock ${moved} ms`);
  return p;
}
