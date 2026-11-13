import type { RunnerTestSuite, RunnerTask } from "vitest";

/**
 * Test-level sharding for CI: with FACTORY_TEST_SHARD="k/n", shard k runs
 * every n-th test of each file, from a starting point that varies by file.
 *
 * Vitest's own --shard splits by file, and one acceptance file runs for half
 * an hour on a Windows runner, so it alone would set the floor. Splitting
 * by position within each file spreads every file evenly across shards.
 * The union of shards 1..n is the whole suite, each test exactly once.
 * test/shard.ts applies it; this module holds the pure parts.
 *
 * @see parseShard
 * @see inShard
 */

/**
 * Reads "k/n" (1 <= k <= n) into its parts; unset or empty means no sharding.
 *
 * @param value The environment variable's value, e.g. "2/4".
 * @returns `{ index: 2, count: 4 }`, or undefined when unset.
 * @throws Error on anything else, so a typo never silently runs nothing.
 */
export function parseShard(value: string | undefined): { index: number; count: number } | undefined {
  if (value === undefined || value === "") return undefined;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`FACTORY_TEST_SHARD must be "k/n" with 1 <= k <= n, not ${JSON.stringify(value)}`);
  return { index, count };
}

/**
 * Every test in a file, in declaration order, so a test's position is the
 * same in every shard.
 *
 * @param suite The file (or a suite in it).
 * @returns Test ids, depth first.
 */
export function testIds(suite: RunnerTestSuite | { tasks: RunnerTask[] }): string[] {
  return suite.tasks.flatMap((t) => (t.type === "suite" ? testIds(t) : [t.id]));
}

/**
 * A small stable number for a file, so files whose test count isn't a
 * multiple of n don't all leave their extra test on shard 1.
 *
 * @param name The file's path relative to the project root.
 * @returns FNV-1a of the name.
 */
export function fileOffset(name: string): number {
  let h = 0x811c9dc5;
  for (const c of name) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}

/**
 * Whether this shard runs the test at `position` in its file.
 *
 * @param position Zero-based place of the test in its file.
 * @param offset The file's {@link fileOffset}.
 * @param shard The parsed FACTORY_TEST_SHARD.
 * @returns true for exactly one shard of every (position, offset).
 */
export function inShard(position: number, offset: number, shard: { index: number; count: number }): boolean {
  return (position + offset) % shard.count === shard.index - 1;
}
