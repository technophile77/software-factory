import { describe, expect, it } from "vitest";
import { EndpointAddressError, classifyAddress, resolveEndpoint, type EndpointInput } from "../src/config/endpoint-address";

type Cls = "private" | "public" | null;

describe("classifyAddress: IPv4 range edges", () => {
  const rows: [string, Cls][] = [
    ["9.255.255.255", "public"], ["10.0.0.0", "private"], ["10.255.255.255", "private"], ["11.0.0.0", "public"],
    ["172.15.255.255", "public"], ["172.16.0.0", "private"], ["172.31.255.255", "private"], ["172.32.0.0", "public"],
    ["192.167.255.255", "public"], ["192.168.0.0", "private"], ["192.168.255.255", "private"], ["192.169.0.0", "public"],
    ["169.253.255.255", "public"], ["169.254.0.0", "private"], ["169.254.255.255", "private"], ["169.255.0.0", "public"],
    ["0.0.0.0", null], ["0.255.255.255", null], ["1.0.0.0", "public"],
    ["100.63.255.255", "public"], ["100.64.0.0", null], ["100.127.255.255", null], ["100.128.0.0", "public"],
    ["126.255.255.255", "public"], ["127.0.0.1", null], ["128.0.0.0", "public"],
    ["192.0.2.1", null], ["198.18.0.0", null], ["198.19.255.255", null], ["198.20.0.0", "public"],
    ["198.51.100.7", null], ["203.0.113.7", null], ["223.255.255.255", "public"], ["224.0.0.0", null],
    ["239.255.255.255", null], ["240.0.0.0", null], ["255.255.255.255", null], ["8.8.8.8", "public"],
  ];
  it.each(rows)("%s -> %s", (addr, expected) => {
    expect(classifyAddress(addr, false)).toBe(expected);
  });

  it("treats loopback as private only when allowed", () => {
    for (const a of ["127.0.0.1", "127.255.255.255", "::1"]) {
      expect(classifyAddress(a, true)).toBe("private");
      expect(classifyAddress(a, false)).toBeNull();
    }
  });
});

describe("classifyAddress: IPv6", () => {
  const rows: [string, Cls][] = [
    ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null], ["fc00::", "private"], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "private"],
    ["fe00::", null], ["fe7f::1", null], ["fe80::1", "private"], ["febf:ffff::1", "private"], ["fec0::1", null],
    ["fe80::1%eth0", "private"], ["::", null], ["ff02::1", null], ["2606:4700:4700::1111", "public"],
    ["2000::1", "public"], ["3fff:fff::1", null], ["3ffe::1", "public"], ["4000::1", null], ["100::1", null],
    ["2001:db8::1", null], ["2001:4860:4860::8888", "public"], ["2002:808:808::1", null], ["2001:0:4136:e378::1", null],
    ["64:ff9b::808:808", null], ["64:ff9b:1::1", null], ["::808:808", null], ["::10.0.0.1", null],
  ];
  it.each(rows)("%s -> %s", (addr, expected) => {
    expect(classifyAddress(addr, false)).toBe(expected);
  });

  it("classifies IPv4-mapped addresses by the embedded IPv4 address", () => {
    expect(classifyAddress("::ffff:10.0.0.1", false)).toBe("private");
    expect(classifyAddress("::ffff:a00:1", false)).toBe("private");
    expect(classifyAddress("::ffff:192.168.1.1", false)).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8", false)).toBe("public");
    expect(classifyAddress("::ffff:127.0.0.1", false)).toBeNull();
    expect(classifyAddress("::ffff:127.0.0.1", true)).toBe("private");
    expect(classifyAddress("::ffff:100.64.0.1", false)).toBeNull();
  });

  it("returns null for text that is not an address", () => {
    for (const a of ["", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::g", "1::2::3", "10.0.0.1/8"]) {
      expect(classifyAddress(a, true)).toBeNull();
    }
  });
});

describe("resolveEndpoint", () => {
  const base: EndpointInput = { name: "ep", baseUrl: "http://llm.local:8080/v1/", hasKey: false, billing: "local", allowLoopback: false };
  const answers = (...addrs: string[]) => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const refused = (input: EndpointInput, ...addrs: string[]) =>
    expect(resolveEndpoint(input, answers(...addrs))).rejects.toBeInstanceOf(EndpointAddressError);

  it("pins the first answer of a private name and splits the URL", async () => {
    const pinned = await resolveEndpoint(base, answers("192.168.1.20", "192.168.1.21"));
    expect(pinned).toEqual({ name: "ep", class: "private", scheme: "http", host: "llm.local", address: "192.168.1.20", port: 8080, basePath: "/v1" });
  });

  it("defaults ports to 80 and 443 and an empty base path", async () => {
    expect((await resolveEndpoint({ ...base, baseUrl: "http://llm.local" }, answers("10.0.0.5")))).toMatchObject({ port: 80, basePath: "" });
    const pub = { ...base, baseUrl: "https://api.example.com/", hasKey: true, billing: "per_token" as const };
    expect(await resolveEndpoint(pub, answers("8.8.8.8"))).toMatchObject({ class: "public", scheme: "https", port: 443, basePath: "", address: "8.8.8.8" });
  });

  it("accepts private IP literals, https included, without calling lookup", async () => {
    const lookup = async () => { throw new Error("must not be called"); };
    expect(await resolveEndpoint({ ...base, baseUrl: "http://10.1.2.3:9000" }, lookup)).toMatchObject({ address: "10.1.2.3", host: "10.1.2.3", class: "private" });
    expect(await resolveEndpoint({ ...base, baseUrl: "https://[fd00::5]/x" }, lookup)).toMatchObject({ address: "fd00::5", host: "fd00::5", scheme: "https", port: 443 });
    expect(await resolveEndpoint({ ...base, baseUrl: "https://llm.local" }, answers("fe80::1"))).toMatchObject({ scheme: "https", class: "private" });
  });

  it("reads IP literals written in alternative forms as the address they mean", async () => {
    await refused({ ...base, baseUrl: "http://0x7f.1/" });
    await refused({ ...base, baseUrl: "http://2130706433/" });
  });

  it("refuses loopback unless allowed", async () => {
    await refused({ ...base, baseUrl: "http://127.0.0.1:1234" });
    await refused(base, "127.0.0.1");
    expect(await resolveEndpoint({ ...base, baseUrl: "http://localhost:1234", allowLoopback: true }, answers("127.0.0.1"))).toMatchObject({ class: "private" });
  });

  it("refuses an empty answer, a failed lookup and any null-class answer", async () => {
    await refused(base);
    await expect(resolveEndpoint(base, async () => { throw new Error("ENOTFOUND"); })).rejects.toBeInstanceOf(EndpointAddressError);
    await refused(base, "192.168.1.20", "0.0.0.0");
    await refused(base, "100.64.0.1");
    await refused(base, "not-an-ip");
  });

  it("refuses a name resolving to both classes, in either order (FR-4)", async () => {
    await refused(base, "192.168.1.20", "8.8.8.8");
    await refused(base, "8.8.8.8", "192.168.1.20");
    await refused({ ...base, baseUrl: "https://api.example.com", hasKey: true, billing: "per_token" }, "8.8.8.8", "fd00::1");
  });

  it("refuses a public endpoint over http, without a key, or billed local", async () => {
    const pub = { ...base, baseUrl: "https://api.example.com", hasKey: true, billing: "per_token" as const };
    expect(await resolveEndpoint(pub, answers("8.8.8.8"))).toMatchObject({ class: "public" });
    await refused({ ...pub, baseUrl: "http://api.example.com" }, "8.8.8.8");
    await refused({ ...pub, hasKey: false }, "8.8.8.8");
    await refused({ ...pub, billing: "local" }, "8.8.8.8");
    expect(await resolveEndpoint({ ...pub, billing: "subscription" }, answers("8.8.8.8"))).toMatchObject({ class: "public" });
  });

  it("refuses an unusable base URL", async () => {
    for (const baseUrl of ["", "llm.local:8080", "ftp://llm.local", "http://user:pw@llm.invalid"]) {
      await refused({ ...base, baseUrl }, "10.0.0.1");
    }
  });
});

// Independent reference: ranges as integer intervals, membership by comparison.
describe("classifyAddress: stochastic agreement with a reference", () => {
  let seed = 0x5eed1234;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  };
  const randBig = (bits: number): bigint => {
    let v = 0n;
    for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(rand(65536));
    return v & ((1n << BigInt(bits)) - 1n);
  };

  type Range = [bigint, bigint];
  const v4 = (a: number, b: number, c: number, d: number): bigint => BigInt(a * 2 ** 24 + b * 2 ** 16 + c * 256 + d);
  const span = (start: bigint, count: bigint): Range => [start, start + count - 1n];
  const within = (n: bigint, rs: Range[]): boolean => rs.some(([lo, hi]) => n >= lo && n <= hi);

  const V4_PRIV: Range[] = [span(v4(10, 0, 0, 0), 2n ** 24n), span(v4(172, 16, 0, 0), 2n ** 20n), span(v4(192, 168, 0, 0), 2n ** 16n), span(v4(169, 254, 0, 0), 2n ** 16n)];
  const V4_LOOP: Range[] = [span(v4(127, 0, 0, 0), 2n ** 24n)];
  const V4_NONE: Range[] = [
    span(0n, 2n ** 24n), span(v4(100, 64, 0, 0), 2n ** 22n), span(v4(192, 0, 0, 0), 256n), span(v4(192, 0, 2, 0), 256n),
    span(v4(192, 88, 99, 0), 256n), span(v4(198, 18, 0, 0), 2n ** 17n), span(v4(198, 51, 100, 0), 256n), span(v4(203, 0, 113, 0), 256n),
    span(v4(224, 0, 0, 0), 2n ** 29n),
  ];
  const refV4 = (n: bigint, loop: boolean): Cls => {
    if (within(n, V4_LOOP)) return loop ? "private" : null;
    if (within(n, V4_PRIV)) return "private";
    return within(n, V4_NONE) ? null : "public";
  };

  const top = (hexTop: bigint, bitsGiven: number): Range => span(hexTop << BigInt(128 - bitsGiven), 1n << BigInt(128 - bitsGiven));
  const V6_PRIV: Range[] = [top(0xfcn >> 1n, 7), top(0xfe80n >> 6n, 10)];
  const V6_NONE: Range[] = [
    top(0x2001n << 7n, 23), // 2001::/23
    top(0x20010010n >> 4n, 28), top(0x20010020n >> 4n, 28), top(0x20010db8n, 32), top(0x2002n, 16), top(0x3fff0n >> 0n, 20),
    span(0n, 2n ** 96n), span(0x0064ff9bn << 96n, 2n ** 96n), span((0x0064ff9bn << 96n) | (1n << 80n), 2n ** 80n),
  ];
  const V6_GLOBAL: Range = top(1n, 3);
  const refV6 = (n: bigint, loop: boolean): Cls => {
    if (n >> 32n === 0xffffn) return refV4(n & 0xffffffffn, loop);
    if (n === 1n) return loop ? "private" : null;
    if (within(n, V6_NONE)) return null;
    if (within(n, V6_PRIV)) return "private";
    return within(n, [V6_GLOBAL]) ? "public" : null;
  };

  const fmtV4 = (n: bigint): string => [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n)).join(".");
  const fmtV6 = (n: bigint): string => Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)).join(":");

  const randV4 = (): bigint => {
    const anchors = [v4(10, 0, 0, 0), v4(172, 16, 0, 0), v4(192, 168, 0, 0), v4(169, 254, 0, 0), v4(127, 0, 0, 0), v4(100, 64, 0, 0), v4(198, 18, 0, 0), v4(224, 0, 0, 0)];
    const mode = rand(3);
    if (mode === 0) return randBig(32);
    const a = anchors[rand(anchors.length)]!;
    return mode === 1 ? (a + randBig(22)) & 0xffffffffn : (a + BigInt(rand(5)) - 2n) & 0xffffffffn;
  };
  const randV6 = (): bigint => {
    const prefixes = [0xfc00n, 0xfd00n, 0xfe80n, 0xfec0n, 0xff02n, 0x2001n, 0x2002n, 0x2606n, 0x3fffn, 0x0064n, 0n];
    const mode = rand(4);
    if (mode === 0) return randBig(128);
    if (mode === 1) return (0xffffn << 32n) | randV4();
    const p = prefixes[rand(prefixes.length)]!;
    const n = (p << 112n) | randBig(112);
    return mode === 2 ? n : n & ~(2n ** BigInt(rand(112)) - 1n);
  };

  it("matches the reference on random IPv4 and IPv6 addresses, loopback allowed or not", () => {
    for (let i = 0; i < 20000; i++) {
      const loop = rand(2) === 0;
      const n4 = randV4();
      expect(classifyAddress(fmtV4(n4), loop), fmtV4(n4)).toBe(refV4(n4, loop));
      const n6 = randV6();
      expect(classifyAddress(fmtV6(n6), loop), fmtV6(n6)).toBe(refV6(n6, loop));
    }
  });

  it("always refuses a name whose answers include a public and a private address", async () => {
    const input: EndpointInput = { name: "ep", baseUrl: "https://mix.example.com", hasKey: true, billing: "per_token", allowLoopback: true };
    for (let i = 0; i < 300; i++) {
      const pool = Array.from({ length: 2 + rand(5) }, () => (rand(2) ? fmtV4(randV4()) : fmtV6(randV6())));
      const classes = pool.map((a) => refV4OrV6(a));
      const hasBoth = classes.includes("private") && classes.includes("public");
      const lookup = async () => pool.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      if (hasBoth) await expect(resolveEndpoint(input, lookup)).rejects.toBeInstanceOf(EndpointAddressError);
    }
    // Guarantee the property was exercised with explicit mixes drawn from the generators.
    for (let i = 0; i < 100; i++) {
      const priv = fmtV4(v4(10, 0, 0, 0) + randBig(24));
      let pub = randV4();
      while (refV4(pub, true) !== "public") pub = randV4();
      const order = rand(2) ? [priv, fmtV4(pub)] : [fmtV4(pub), priv];
      const lookup = async () => order.map((address) => ({ address, family: 4 }));
      await expect(resolveEndpoint(input, lookup)).rejects.toBeInstanceOf(EndpointAddressError);
    }
  });

  function refV4OrV6(a: string): Cls {
    return a.includes(":") ? refV6(parseV6(a), true) : refV4(parseV4(a), true);
  }
  function parseV4(a: string): bigint {
    return a.split(".").reduce((acc, o) => acc * 256n + BigInt(o), 0n);
  }
  function parseV6(a: string): bigint {
    return a.split(":").reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n);
  }
});
