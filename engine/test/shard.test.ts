import { describe, expect, it } from "vitest";
import { fileOffset, inShard, parseShard, testIds } from "./shard-select";

describe("FACTORY_TEST_SHARD (H-0130)", () => {
  it("parses k/n and treats unset or empty as no sharding", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, count: 4 });
    expect(parseShard("1/1")).toEqual({ index: 1, count: 1 });
    expect(parseShard(undefined)).toBeUndefined();
    expect(parseShard("")).toBeUndefined();
  });

  it("refuses anything else, so a typo never runs an empty shard", () => {
    for (const bad of ["0/4", "5/4", "1/0", "2", "a/b", " 1/2", "1/2 ", "-1/2", "1.5/2"]) {
      expect(() => parseShard(bad), bad).toThrow(/FACTORY_TEST_SHARD/);
    }
  });

  it("lists a file's tests depth first, in declaration order", () => {
    const file = {
      tasks: [
        { type: "test", id: "a" },
        { type: "suite", id: "s", tasks: [{ type: "test", id: "b" }, { type: "suite", id: "t", tasks: [{ type: "test", id: "c" }] }] },
        { type: "test", id: "d" },
      ],
    };
    expect(testIds(file as never)).toEqual(["a", "b", "c", "d"]);
  });

  it("gives every test to exactly one shard, and spreads a file evenly (random files and shard counts)", () => {
    for (let round = 0; round < 200; round++) {
      const count = 1 + Math.floor(Math.random() * 8);
      const tests = Math.floor(Math.random() * 300);
      const offset = fileOffset(`test/acceptance/${Math.random().toString(36).slice(2)}.test.ts`);
      const perShard = Array.from({ length: count }, () => 0);
      for (let pos = 0; pos < tests; pos++) {
        const owners = perShard.flatMap((_, k) => (inShard(pos, offset, { index: k + 1, count }) ? [k] : []));
        expect(owners.length, `test ${pos} of ${tests}, ${count} shards`).toBe(1);
        perShard[owners[0]!] = (perShard[owners[0]!] ?? 0) + 1;
      }
      expect(Math.max(...perShard) - Math.min(...perShard)).toBeLessThanOrEqual(1);
    }
  });

  it("offsets files differently, so remainders don't all land on shard 1", () => {
    const names = Array.from({ length: 40 }, (_, i) => `test/f${i}.test.ts`);
    const firsts = new Set(names.map((n) => fileOffset(n) % 4));
    expect(firsts.size).toBeGreaterThan(1);
    expect(fileOffset("test/a.test.ts")).toBe(fileOffset("test/a.test.ts"));
  });
});
