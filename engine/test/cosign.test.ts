import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DockerError } from "../src/docker/cli";
import { type CosignOptions, type CosignRunner, LITELLM_COSIGN_KEY_SHA256, cosignPlatformKey, ensureCosign, makeCosignVerifier, parseCosignPins } from "../src/docker/cosign";
import { tmpdir } from "./helpers";

const DOCKER_DIR = path.join(__dirname, "..", "docker");
const REF = `ghcr.io/berriai/litellm-non_root@sha256:${"e".repeat(64)}`;
const BINARY = Buffer.from("pretend cosign binary");
const BINARY_SHA = crypto.createHash("sha256").update(BINARY).digest("hex");

function rig(o: { pins?: CosignOptions["pins"]; binary?: Buffer | null; run?: CosignRunner } = {}) {
  const dir = tmpdir();
  const bin = path.join(dir, "cosign");
  if (o.binary !== null) fs.writeFileSync(bin, o.binary ?? BINARY);
  const calls: Array<{ binary: string; args: string[] }> = [];
  const run: CosignRunner = o.run ?? (async () => ({ code: 0, stderr: "" }));
  const opts: CosignOptions = {
    path: bin, keyFile: path.join(DOCKER_DIR, "litellm-cosign.pub"), platform: "linux", arch: "x64",
    pins: o.pins ?? { version: "v3.1.4", sha256: { "linux-amd64": BINARY_SHA } },
    run: async (binary, args) => (calls.push({ binary, args }), run(binary, args)),
  };
  return { opts, calls, bin, dir };
}

describe("the shipped cosign pins", () => {
  const pins = parseCosignPins(fs.readFileSync(path.join(DOCKER_DIR, "cosign-sha256.json"), "utf8"));

  it("name a version and lowercase SHA-256 values for the platforms the engine runs on", () => {
    expect(pins.version).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const k of ["windows-amd64", "linux-amd64", "linux-arm64", "darwin-arm64"]) expect(pins.sha256[k], k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ship the key file whose hash the engine pins", () => {
    const text = fs.readFileSync(path.join(DOCKER_DIR, "litellm-cosign.pub"), "utf8").replace(/\r/g, "");
    expect(crypto.createHash("sha256").update(text).digest("hex")).toBe(LITELLM_COSIGN_KEY_SHA256);
    expect(text).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
  });
});

describe("parseCosignPins and cosignPlatformKey", () => {
  it("parses a pins file and refuses a malformed one", () => {
    expect(parseCosignPins('{"version":"v1","sha256":{"linux-amd64":"ab"}}')).toEqual({ version: "v1", sha256: { "linux-amd64": "ab" } });
    for (const bad of ["nope", "null", "[]", '{"version":1,"sha256":{}}', '{"version":"v1"}', '{"version":"v1","sha256":[]}', '{"version":"v1","sha256":{"a":1}}']) {
      expect(() => parseCosignPins(bad), bad).toThrow(DockerError);
    }
  });

  it("names platforms like the cosign release assets", () => {
    expect(cosignPlatformKey("win32", "x64")).toBe("windows-amd64");
    expect(cosignPlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(cosignPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cosignPlatformKey("freebsd", "x64")).toBeNull();
    expect(cosignPlatformKey("linux", "ia32")).toBeNull();
  });
});

describe("ensureCosign", () => {
  it("returns the path of a binary that matches the pinned hash", () => {
    const r = rig();
    expect(ensureCosign(r.opts)).toBe(r.bin);
  });

  it("refuses with 'cosign checksum not pinned' when the pin map is empty, or has no entry for this platform", () => {
    expect(() => ensureCosign(rig({ pins: { version: "v3.1.4", sha256: {} } }).opts)).toThrow("cosign checksum not pinned");
    expect(() => ensureCosign(rig({ pins: { version: "v3.1.4", sha256: { "windows-amd64": BINARY_SHA } } }).opts)).toThrow("cosign checksum not pinned");
    expect(() => ensureCosign(rig({ pins: { version: "v3.1.4", sha256: { "linux-amd64": "not-a-hash" } } }).opts)).toThrow("cosign checksum not pinned");
    expect(() => ensureCosign({ ...rig().opts, platform: "freebsd" })).toThrow("cosign checksum not pinned");
  });

  it("refuses a binary with a different hash, a missing file and a directory", () => {
    expect(() => ensureCosign(rig({ binary: Buffer.from("tampered") }).opts)).toThrow(/doesn't match the pinned/);
    expect(() => ensureCosign(rig({ binary: null }).opts)).toThrow(/isn't installed/);
    const r = rig({ binary: null });
    fs.mkdirSync(r.bin);
    expect(() => ensureCosign(r.opts)).toThrow(/isn't installed/);
  });
});

describe("makeCosignVerifier", () => {
  it("runs the hash-checked cosign with an argument array: verify --key <file> <image@digest>", async () => {
    const r = rig();
    await makeCosignVerifier(r.opts)(REF);
    expect(r.calls).toEqual([{ binary: r.bin, args: ["verify", "--key", r.opts.keyFile, REF] }]);
  });

  it("refuses, without running anything, when the binary's hash doesn't match", async () => {
    const r = rig({ binary: Buffer.from("tampered") });
    await expect(makeCosignVerifier(r.opts)(REF)).rejects.toThrow(/doesn't match the pinned/);
    expect(r.calls).toEqual([]);
  });

  it("refuses without running anything when no checksum is pinned", async () => {
    const r = rig({ pins: { version: "v3.1.4", sha256: {} } });
    await expect(makeCosignVerifier(r.opts)(REF)).rejects.toThrow("cosign checksum not pinned");
    expect(r.calls).toEqual([]);
  });

  it("refuses when cosign fails the signature, and says why", async () => {
    const r = rig({ run: async () => ({ code: 1, stderr: "  no matching signatures\n" }) });
    await expect(makeCosignVerifier(r.opts)(REF)).rejects.toThrow(/cosign refused the signature.*exit 1.*no matching signatures/);
  });

  it("refuses a key file that is missing or isn't the pinned key", async () => {
    const r = rig();
    await expect(makeCosignVerifier({ ...r.opts, keyFile: path.join(r.dir, "none.pub") })(REF)).rejects.toThrow(/key file is missing/);
    const other = path.join(r.dir, "other.pub");
    fs.writeFileSync(other, "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n");
    await expect(makeCosignVerifier({ ...r.opts, keyFile: other })(REF)).rejects.toThrow(/isn't the pinned key/);
    expect(r.calls).toEqual([]);
  });

  it("accepts the pinned key with Windows line endings", async () => {
    const r = rig();
    const crlf = path.join(r.dir, "crlf.pub");
    fs.writeFileSync(crlf, fs.readFileSync(r.opts.keyFile, "utf8").replace(/\n/g, "\r\n"));
    await makeCosignVerifier({ ...r.opts, keyFile: crlf })(REF);
    expect(r.calls).toHaveLength(1);
  });

  it("takes no proof from the environment: a claim variable changes nothing", async () => {
    const saved = process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED;
    process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED = REF.split("@")[1]!;
    try {
      const r = rig({ run: async () => ({ code: 1, stderr: "bad" }) });
      await expect(makeCosignVerifier(r.opts)(REF)).rejects.toThrow(DockerError);
      const noBinary = rig({ binary: null });
      await expect(makeCosignVerifier(noBinary.opts)(REF)).rejects.toThrow(/isn't installed/);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED;
      else process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED = saved;
    }
  });
});
