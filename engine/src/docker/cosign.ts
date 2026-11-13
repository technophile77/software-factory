import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DockerError } from "./cli";

/**
 * SHA-256 of `engine/docker/litellm-cosign.pub` (line endings normalised to LF).
 * The key is LiteLLM's image-signing key as committed at
 * BerriAI/litellm e82a3c646908ba0a6ee0beddc4310d7a6cac4065 ("Rotate the cosign
 * image-signing public key", 2026-10-23); the engine refuses a key file that
 * differs, so changing the key is a reviewed code change (litellm review,
 * condition 1; OQ-13).
 */
export const LITELLM_COSIGN_KEY_SHA256 = "e3fe3e08c44b16407fe0b37c43b4f8b603b3a0f4ee74c29e647bc022d762c2c0";

/** The parsed `cosign-sha256.json`: the cosign release the engine accepts and the SHA-256 of its binary per `<os>-<arch>`. */
export interface CosignPins {
  version: string;
  sha256: Record<string, string>;
}

/** Result of one cosign run; only what the check needs. */
export interface CosignResult {
  code: number;
  stderr: string;
}

/** Runs the binary with an argument array (never a shell); tests replace it. */
export type CosignRunner = (binary: string, args: string[]) => Promise<CosignResult>;

/** Where cosign and the key are, and how to run them; every field but `path`, `pins` and `keyFile` exists for tests. */
export interface CosignOptions {
  /** The configured cosign binary, in a folder only the engine's user can write. */
  path: string;
  pins: CosignPins;
  /** The LiteLLM public key file (`engine/docker/litellm-cosign.pub`). */
  keyFile: string;
  run?: CosignRunner;
  platform?: NodeJS.Platform;
  arch?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: "windows", linux: "linux", darwin: "darwin" };
const ARCH_NAMES: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const VERIFY_TIMEOUT_MS = 120_000;

/** The `cosign-sha256.json` key for a platform, e.g. `linux-amd64`; null when cosign has no build the engine pins for it. */
export function cosignPlatformKey(platform: NodeJS.Platform, arch: string): string | null {
  const os = OS_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  return os && cpu ? `${os}-${cpu}` : null;
}

/**
 * Parses the text of `cosign-sha256.json`.
 *
 * @example
 * parseCosignPins('{"version":"v3.1.4","sha256":{}}'); // { version: "v3.1.4", sha256: {} }
 * @throws DockerError when the text isn't a version and a map of strings.
 */
export function parseCosignPins(text: string): CosignPins {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new DockerError("cosign checksums file isn't valid JSON");
  }
  const d = doc as { version?: unknown; sha256?: unknown } | null;
  const map = d?.sha256;
  if (typeof d?.version !== "string" || !map || typeof map !== "object" || Array.isArray(map) || !Object.values(map).every((v) => typeof v === "string")) {
    throw new DockerError("cosign checksums file has no version and sha256 map");
  }
  return { version: d.version, sha256: { ...(map as Record<string, string>) } };
}

function sha256Of(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads a regular file through a single descriptor. Checking the path and then
 * reading it by path leaves a window in which the path can be swapped (a
 * file-system race), so the type check and the read both use the open fd; on
 * POSIX O_NOFOLLOW also makes the open itself refuse a symlink (Windows has no
 * such flag, where it is 0).
 *
 * @throws Error when the file can't be opened or isn't a regular file.
 */
function readRegularFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("not a file");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** A hash-verified private copy of the cosign binary, and the call that removes it. */
export interface VerifiedCosign {
  /** The copy to execute, in a directory only the engine's user can enter; differs from the configured path. */
  path: string;
  /** Deletes the copy and its directory; safe to call more than once. */
  cleanup(): void;
}

/**
 * Checks that the file at the configured path is the pinned cosign build for
 * this OS and CPU, by SHA-256, and returns an owner-only copy of the verified
 * bytes. Running the copy rather than the configured path shrinks the gap
 * between the check and the exec: nobody else can write to the copy. The
 * engine never downloads cosign: the owner installs it (hygiene step) at the
 * configured path. The caller must call `cleanup()` once cosign has run.
 *
 * @example
 * const c = ensureCosign({ path: "C:/engine/bin/cosign.exe", pins, keyFile: "litellm-cosign.pub" });
 * try { await run(c.path, args); } finally { c.cleanup(); }
 * @throws DockerError "cosign checksum not pinned" when no hash is pinned for this platform, or when the file is missing, isn't a regular file (a symlink is refused on POSIX), or doesn't match the hash.
 */
export function ensureCosign(o: CosignOptions): VerifiedCosign {
  const key = cosignPlatformKey(o.platform ?? process.platform, o.arch ?? process.arch);
  const want = key ? o.pins.sha256[key] : undefined;
  if (!key || want === undefined || !HEX64.test(want)) throw new DockerError(`cosign checksum not pinned for ${key ?? `${o.platform ?? process.platform}/${o.arch ?? process.arch}`}`);
  let bytes: Buffer;
  try {
    bytes = readRegularFile(o.path);
  } catch {
    throw new DockerError(`cosign ${o.pins.version} isn't installed as a regular file at the configured path`);
  }
  if (sha256Of(bytes) !== want) throw new DockerError(`the cosign binary doesn't match the pinned ${o.pins.version} ${key} SHA-256`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cosign-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.chmodSync(dir, 0o700);
    // Keep the original file name: Windows decides executability from the extension.
    const copy = path.join(dir, path.basename(o.path));
    fs.writeFileSync(copy, bytes, { flag: "wx", mode: 0o700 });
    return { path: copy, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** The pinned LiteLLM public key's text, or a DockerError when the file is missing or isn't the pinned key. */
function checkedKeyFile(keyFile: string): string {
  let text: string;
  try {
    text = readRegularFile(keyFile).toString("utf8");
  } catch {
    throw new DockerError("the pinned LiteLLM cosign public key file is missing");
  }
  if (sha256Of(Buffer.from(text.replace(/\r/g, ""), "utf8")) !== LITELLM_COSIGN_KEY_SHA256) throw new DockerError("the LiteLLM cosign public key file isn't the pinned key");
  return keyFile;
}

/** Real runner: no shell, a hard time limit, and only the variables cosign needs to find the registry credentials. */
export const execCosign: CosignRunner = (binary, args) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "DOCKER_CONFIG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    execFile(binary, args, { env, timeout: VERIFY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
      resolve({ code, stderr: String(stderr) });
    });
  });

/**
 * Makes the check that an image reference carries a valid cosign signature
 * under the pinned LiteLLM key: `cosign verify --key <file> <ref>`, with the
 * binary hash-checked first and the key file checked against its pinned hash.
 * The only proof the engine accepts is cosign's own exit code 0.
 *
 * @example
 * const verify = makeCosignVerifier({ path, pins, keyFile });
 * await verify("ghcr.io/berriai/litellm-non_root@sha256:...");
 * @throws DockerError (from the returned function) when cosign or the key is missing or wrong, or cosign refuses the signature.
 * @see ensureCosign
 */
export function makeCosignVerifier(o: CosignOptions): (imageRef: string) => Promise<void> {
  return async (imageRef) => {
    const binary = ensureCosign(o);
    let r: CosignResult;
    try {
      const key = checkedKeyFile(o.keyFile);
      r = await (o.run ?? execCosign)(binary.path, ["verify", "--key", key, imageRef]);
    } finally {
      binary.cleanup();
    }
    if (r.code !== 0) throw new DockerError(`cosign refused the signature of ${imageRef} (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  };
}
