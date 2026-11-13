import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ENDPOINTS_FILE } from "../src/constants";
import { EndpointsError, readEndpointsFile, type Endpoint } from "../src/config/endpoints";
import { validateManifest } from "../src/config/manifest";
import { ConfigError } from "../src/config/paths-file";
import { parseRungModel } from "../src/config/models";
import type { OsApi, WindowsApi } from "../src/os/ffi";
import { MemoryCredentialStore, SecretError, endpointKeyName, isSecretName } from "../src/secrets";
import { canSymlink, needsSymlinks } from "./acceptance/support/platform";
import { manifestYaml, tmpdir } from "./helpers";

const ME = "S-1-5-21-1-2-3-1001";
/** A Windows OsApi that reports the file as owner-only, so the content checks run on every platform. */
const ownerOnlyWin: OsApi = {
  platform: "win32",
  unix: () => {
    throw new Error("x");
  },
  windows: () => ({ currentUserSid: () => ME, fileSddl: () => `O:${ME}D:(A;;FA;;;${ME})` }) as unknown as WindowsApi,
  credentials: () => {
    throw new Error("x");
  },
};

const LAN = { base_url: "http://llm.local:8080", model: "qwen3.8-27b", api: "anthropic", billing: "local" };

function load(doc: unknown, text?: string) {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, ENDPOINTS_FILE), text ?? YAML.stringify(doc));
  return readEndpointsFile(root, ownerOnlyWin);
}

const one = (over: Record<string, unknown>) => ({ endpoints: { lan: { ...LAN, ...over } } });

describe("readEndpointsFile (F-013 FR-2, H-0135)", () => {
  it("treats a missing file as no endpoints", () => {
    expect(readEndpointsFile(tmpdir(), ownerOnlyWin)).toEqual({ endpoints: [] });
  });

  it("fills in the defaults", () => {
    expect(load({ endpoints: { lan: LAN } }).endpoints).toEqual([
      { name: "lan", ...LAN, max_sessions: 1, deadline: { margin_s: 60 }, allow_loopback: false },
    ]);
  });

  it("reads a per_token and a subscription endpoint with their billing", () => {
    const got = load({
      endpoints: {
        paid: { ...LAN, billing: "per_token", prices: { input_per_mtok: 1, output_per_mtok: 2.5 }, api_key_ref: "paid-key", max_sessions: 4, api: "openai" },
        plan: {
          ...LAN,
          billing: "subscription",
          plan: { limits: [{ kind: "requests", count: 100, window: "5h" }], reserve_pct: 0 },
          deadline: { margin_s: 10 },
          allow_loopback: true,
        },
      },
    }).endpoints;
    expect(got[0]).toMatchObject({ name: "paid", billing: "per_token", prices: { input_per_mtok: 1, output_per_mtok: 2.5 }, api_key_ref: "paid-key", max_sessions: 4, api: "openai" });
    expect(got[1]).toMatchObject({ name: "plan", billing: "subscription", plan: { limits: [{ kind: "requests", count: 100, window: "5h" }], reserve_pct: 0 }, deadline: { margin_s: 10 }, allow_loopback: true });
    expect(got[0]).not.toHaveProperty("plan");
    expect(got[1]).not.toHaveProperty("prices");
  });

  it("defaults the subscription reserve to 10", () => {
    const e = load(one({ billing: "subscription", plan: { limits: [{ kind: "output_tokens", count: 5, window: "month" }] } })).endpoints[0]!;
    expect(e).toMatchObject({ billing: "subscription", plan: { reserve_pct: 10 } });
  });

  const priced = { billing: "per_token", prices: { input_per_mtok: 1, output_per_mtok: 2 } };
  const plan = (over: Record<string, unknown> = {}) => ({ billing: "subscription", plan: { limits: [{ kind: "requests", count: 1, window: "day" }], ...over } });
  const refusals: Array<[string, unknown]> = [
    ["unknown top-level key", { endpoints: {}, extra: 1 }],
    ["unknown endpoint key", one({ extra: 1 })],
    ["unknown prices key", one({ ...priced, prices: { input_per_mtok: 1, output_per_mtok: 2, x: 1 } })],
    ["unknown plan key", one(plan({ x: 1 }))],
    ["unknown limit key", one(plan({ limits: [{ kind: "requests", count: 1, window: "day", x: 1 }] }))],
    ["unknown deadline key", one({ deadline: { margin_s: 60, x: 1 } })],
    ["uppercase name", { endpoints: { Lan: LAN } }],
    ["long name", { endpoints: { ["a".repeat(33)]: LAN } }],
    ["name anthropic", { endpoints: { anthropic: LAN } }],
    ["name with slash", { endpoints: { "a/b": LAN } }],
    ["no base_url", one({ base_url: undefined })],
    ["ftp url", one({ base_url: "ftp://h/" })],
    ["relative url", one({ base_url: "/v1" })],
    ["url userinfo", one({ base_url: "http://u:p@h/" })],
    ["url user only", one({ base_url: "http://u@h/" })],
    ["url query", one({ base_url: "http://h/?k=1" })],
    ["url empty query", one({ base_url: "http://h/?" })],
    ["url fragment", one({ base_url: "http://h/#x" })],
    ["model with space", one({ model: "a b" })],
    ["no model", one({ model: undefined })],
    ["bad api", one({ api: "gemini" })],
    ["no api", one({ api: undefined })],
    ["bad key ref", one({ api_key_ref: "Bad_Ref" })],
    ["numeric key ref", one({ api_key_ref: 5 })],
    ["max_sessions 0", one({ max_sessions: 0 })],
    ["max_sessions 17", one({ max_sessions: 17 })],
    ["max_sessions fraction", one({ max_sessions: 1.5 })],
    ["billing missing", one({ billing: undefined })],
    ["billing unknown", one({ billing: "free" })],
    ["per_token without prices", one({ billing: "per_token" })],
    ["negative price", one({ billing: "per_token", prices: { input_per_mtok: -1, output_per_mtok: 2 } })],
    ["string price", one({ billing: "per_token", prices: { input_per_mtok: "1", output_per_mtok: 2 } })],
    ["missing output price", one({ billing: "per_token", prices: { input_per_mtok: 1 } })],
    ["prices on local", one({ prices: { input_per_mtok: 1, output_per_mtok: 2 } })],
    ["prices on subscription", one({ ...plan(), prices: { input_per_mtok: 1, output_per_mtok: 2 } })],
    ["subscription without plan", one({ billing: "subscription" })],
    ["plan on local", one({ plan: { limits: [] } })],
    ["plan on per_token", one({ ...priced, plan: plan().plan })],
    ["empty limits", one(plan({ limits: [] }))],
    ["limit bad kind", one(plan({ limits: [{ kind: "bytes", count: 1, window: "day" }] }))],
    ["limit zero count", one(plan({ limits: [{ kind: "requests", count: 0, window: "day" }] }))],
    ["limit fractional count", one(plan({ limits: [{ kind: "requests", count: 1.5, window: "day" }] }))],
    ["limit bad window", one(plan({ limits: [{ kind: "requests", count: 1, window: "year" }] }))],
    ["reserve 91", one(plan({ reserve_pct: 91 }))],
    ["reserve -1", one(plan({ reserve_pct: -1 }))],
    ["margin 9", one({ deadline: { margin_s: 9 } })],
    ["margin 3601", one({ deadline: { margin_s: 3601 } })],
    ["allow_loopback string", one({ allow_loopback: "yes" })],
    ["endpoint not a mapping", { endpoints: { lan: "x" } }],
    ["endpoints a list", { endpoints: [] }],
  ];
  it.each(refusals)("refuses %s", (_label, doc) => {
    expect(() => load(doc)).toThrow(EndpointsError);
  });

  it("refuses non-YAML, duplicate keys, aliases and a non-mapping root", () => {
    for (const text of ["[", "endpoints: {}\nendpoints: {}\n", "a: &x 1\nb: *x\n", "- 1\n", ""]) {
      expect(() => load(null, text)).toThrow(EndpointsError);
    }
  });

  it("is a ConfigError, so the engine reports it like the other config problems", () => {
    expect(() => load({ extra: 1 })).toThrow(ConfigError);
  });

  it("never echoes a value from the file in its message", () => {
    const secret = "sk-SECRETVALUE123";
    const docs = [
      one({ [secret]: 1 }),
      one({ base_url: `http://user:${secret}@h/` }),
      one({ api_key_ref: secret }),
      one({ model: `a b ${secret}` }),
      { endpoints: { [secret]: LAN } },
      { [secret]: 1 },
    ];
    for (const doc of docs) {
      let msg = "";
      try {
        load(doc);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(secret);
    }
  });

  it("refuses a file over 64 KiB", () => {
    expect(() => load(null, `endpoints: {}\n# ${"x".repeat(70 * 1024)}\n`)).toThrow(/small regular file/);
  });

  it("refuses a file that is a directory", () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, ENDPOINTS_FILE));
    expect(() => readEndpointsFile(root, ownerOnlyWin)).toThrow(/small regular file/);
  });

  it.skipIf(!canSymlink())(needsSymlinks("refuses a symbolic link"), () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, "real.yaml"), "endpoints: {}\n");
    fs.symlinkSync(path.join(root, "real.yaml"), path.join(root, ENDPOINTS_FILE));
    expect(() => readEndpointsFile(root, ownerOnlyWin)).toThrow(/symbolic link/);
  });

  it("on Windows, refuses a file others can write or that the FFI module can't check", () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, ENDPOINTS_FILE), "endpoints: {}\n");
    const win = (fileSddl: () => string): OsApi => ({ ...ownerOnlyWin, windows: () => ({ currentUserSid: () => ME, fileSddl }) as unknown as WindowsApi });
    expect(readEndpointsFile(root, win(() => `O:${ME}D:(A;;FA;;;${ME})`))).toEqual({ endpoints: [] });
    expect(() => readEndpointsFile(root, win(() => `O:${ME}D:(A;;FA;;;${ME})(A;;FW;;;BU)`))).toThrow(/writable by nobody else/);
    expect(() => readEndpointsFile(root, win(() => `O:S-1-5-21-9-9-9-1D:(A;;FA;;;${ME})`))).toThrow(/writable by nobody else/);
    expect(() =>
      readEndpointsFile(root, win(() => {
        throw new Error("ffi");
      })),
    ).toThrow(/writable by nobody else/);
  });

  it.skipIf(process.platform === "win32")("on POSIX, refuses a group- or world-writable file", () => {
    const root = tmpdir();
    const f = path.join(root, ENDPOINTS_FILE);
    fs.writeFileSync(f, "endpoints: {}\n", { mode: 0o600 });
    const posix: OsApi = { ...ownerOnlyWin, platform: "linux" };
    expect(readEndpointsFile(root, posix)).toEqual({ endpoints: [] });
    fs.chmodSync(f, 0o620);
    expect(() => readEndpointsFile(root, posix)).toThrow(/group- or world-writable/);
  });
});

/** Small deterministic PRNG (mulberry32) so a failing seed can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("readEndpointsFile round trip (stochastic)", () => {
  const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";
  it("parses random valid configs back to the object that was serialised", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      const pick = <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)]!;
      const name = () => Array.from({ length: int(1, 32) }, () => pick([...NAME_CHARS])).join("");
      const expected: Endpoint[] = [];
      const written: Record<string, unknown> = {};
      for (let n = int(0, 5); n > 0; n--) {
        const nm = name();
        if (nm === "anthropic" || nm in written) continue;
        const common = {
          base_url: `${pick(["http", "https"])}://${pick(["llm.local", "10.0.0.5", "api.example.com", "[::1]"])}${pick(["", ":8080", "/v1", ":9/x/y"])}`,
          model: `m${int(0, 9999)}-${pick(["a", "B", "q.1", "x:7b"])}`,
          api: pick(["anthropic", "openai"] as const),
        };
        const w: Record<string, unknown> = { ...common };
        const e: Record<string, unknown> = { name: nm, ...common };
        if (r() < 0.5) {
          const ref = name();
          w.api_key_ref = ref;
          e.api_key_ref = ref;
        }
        const ms = r() < 0.5 ? int(1, 16) : undefined;
        if (ms !== undefined) w.max_sessions = ms;
        e.max_sessions = ms ?? 1;
        const margin = r() < 0.5 ? int(10, 3600) : undefined;
        if (margin !== undefined) w.deadline = { margin_s: margin };
        e.deadline = { margin_s: margin ?? 60 };
        const lb = r() < 0.5 ? r() < 0.5 : undefined;
        if (lb !== undefined) w.allow_loopback = lb;
        e.allow_loopback = lb ?? false;
        const mode = pick(["local", "per_token", "subscription"] as const);
        w.billing = e.billing = mode;
        if (mode === "per_token") {
          const prices = { input_per_mtok: int(0, 100000) / 100, output_per_mtok: int(0, 100000) / 100 };
          w.prices = prices;
          e.prices = prices;
        } else if (mode === "subscription") {
          const limits = Array.from({ length: int(1, 3) }, () => ({ kind: pick(["requests", "input_tokens", "output_tokens"] as const), count: int(1, 1e9), window: pick(["5h", "day", "week", "month"] as const) }));
          const reserve = r() < 0.5 ? int(0, 90) : undefined;
          w.plan = reserve === undefined ? { limits } : { limits, reserve_pct: reserve };
          e.plan = { limits, reserve_pct: reserve ?? 10 };
        }
        written[nm] = w;
        expected.push(e as unknown as Endpoint);
      }
      const root = tmpdir();
      fs.writeFileSync(path.join(root, ENDPOINTS_FILE), YAML.stringify({ endpoints: written }));
      // Digit-only names make JS reorder object keys, and order isn't part of the contract.
      const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);
      const got = readEndpointsFile(root, ownerOnlyWin).endpoints.sort(byName);
      expect(got, `seed ${seed}`).toEqual(expected.sort(byName));
    }
  });
});

describe("endpoint key secrets (F-013 FR-3)", () => {
  it("names a key entry and accepts only that shape", async () => {
    expect(endpointKeyName("lan-key")).toBe("endpoint-key/lan-key");
    expect(isSecretName("endpoint-key/abc-1")).toBe(true);
    for (const bad of ["endpoint-key/", "endpoint-key/Abc", "endpoint-key/a/b", `endpoint-key/${"a".repeat(33)}`, "endpoint-key/a_b", "endpoint-key/a\n"]) {
      expect(isSecretName(bad)).toBe(false);
    }
    expect(() => endpointKeyName("../x")).toThrow(SecretError);
    expect(() => endpointKeyName("")).toThrow(SecretError);
    const store = new MemoryCredentialStore();
    await store.set(endpointKeyName("k1"), "abc123");
    expect(await store.get("endpoint-key/k1")).toBe("abc123");
    await expect(store.get("endpoint-key/BAD")).rejects.toThrow(SecretError);
  });
});

describe("manifest settings.endpoints (SR-8)", () => {
  const withEndpoints = (v: unknown) => {
    const doc = YAML.parse(manifestYaml()) as Record<string, any>;
    doc.settings = { ...doc.settings, endpoints: v };
    return doc;
  };
  it("defaults to none and keeps a listed set in order", () => {
    expect(validateManifest(YAML.parse(manifestYaml()), "c").endpoints).toEqual([]);
    expect(validateManifest(withEndpoints(["lan", "paid-2"]), "c").endpoints).toEqual(["lan", "paid-2"]);
    expect(validateManifest(withEndpoints([]), "c").endpoints).toEqual([]);
  });
  it("refuses a non-list, a bad or duplicate name, and anthropic", () => {
    for (const bad of ["lan", { lan: 1 }, ["Lan"], [1], ["lan", "lan"], ["anthropic"], ["a/b"]]) {
      expect(() => validateManifest(withEndpoints(bad), "c")).toThrow(ConfigError);
    }
  });
});

describe("parseRungModel (F-013 FR-1)", () => {
  it("splits <endpoint>/<model> and leaves Claude ids alone", () => {
    expect(parseRungModel("lan/qwen3.8-27b")).toEqual({ endpoint: "lan", model: "qwen3.8-27b" });
    expect(parseRungModel("lan/org/model:7b")).toEqual({ endpoint: "lan", model: "org/model:7b" });
    expect(parseRungModel("claude-sonnet-4-5")).toEqual({ endpoint: null, model: "claude-sonnet-4-5" });
    expect(parseRungModel("anthropic/claude-x")).toEqual({ endpoint: null, model: "anthropic/claude-x" });
    expect(parseRungModel("Lan/x")).toEqual({ endpoint: null, model: "Lan/x" });
    expect(parseRungModel("lan/")).toEqual({ endpoint: null, model: "lan/" });
    expect(parseRungModel("/x")).toEqual({ endpoint: null, model: "/x" });
  });
});
