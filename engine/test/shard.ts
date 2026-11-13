import { beforeEach } from "vitest";
import { fileOffset, inShard, parseShard, testIds } from "./shard-select";

// Setup file for both projects: with FACTORY_TEST_SHARD="k/n" this worker
// skips every test that belongs to another shard (see shard-select.ts).
const SHARD = parseShard(process.env.FACTORY_TEST_SHARD);

if (SHARD) {
  // One map per worker; the setup file runs once per test file.
  const order = new Map<string, number>();
  beforeEach((ctx) => {
    const file = ctx.task.file;
    if (!order.has(ctx.task.id)) testIds(file).forEach((id, i) => order.set(id, i));
    if (!inShard(order.get(ctx.task.id)!, fileOffset(file.name), SHARD)) ctx.skip();
  });
}
