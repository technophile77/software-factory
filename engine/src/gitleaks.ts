import * as fs from "node:fs";
import * as path from "node:path";
import { GITLEAKS_BINARY_SHA256, GITLEAKS_RULES, GITLEAKS_TIMEOUT_S, GITLEAKS_VERSION } from "./constants";
import { ensureOwnerDir, sha256Hex, writeFileAtomic } from "./fsutil";
import { Children, baseEnv, runFixed } from "./proc";

export class ScanError extends Error {
  override name = "ScanError";
}

export interface Blob {
  sha: string;
  content: Buffer;
}

export type ScanResult = { clean: true } | { clean: false; blobs: string[]; rules: string[] };

export interface SecretsScanner {
  scan(blobs: Blob[]): Promise<ScanResult>;
}

export interface GitleaksOptions {
  binary: string;
  /** Engine-owned folder for the rules file, the empty ignore dir, the working dir and staging. */
  workDir: string;
  children: Children;
  timeoutS?: number;
  /**
   * Only for tests with a stand-in binary. Production uses the pinned
   * SHA-256 for this platform (Gate 1 component review 5).
   */
  expectSha256?: string;
}

/**
 * Runs gitleaks exactly as Gate 1 component review 5 approved it: `dir` mode
 * only, over a fresh 0700 folder of blobs named by their SHA (so no path
 * allowlist or .gitleaksignore in a repo can match), with the fixed flags,
 * the report on stdout and redacted. Exit 0 is clean, 99 is a finding, and
 * anything else fails closed.
 */
export class Gitleaks implements SecretsScanner {
  private readonly rules: string;
  private readonly ignoreDir: string;
  private readonly cwd: string;
  private readonly stagingRoot: string;
  private verified = false;

  constructor(private readonly o: GitleaksOptions) {
    if (!path.isAbsolute(o.binary)) throw new ScanError("gitleaks must be named by absolute path");
    ensureOwnerDir(o.workDir);
    this.rules = path.join(o.workDir, "gitleaks.toml");
    writeFileAtomic(this.rules, GITLEAKS_RULES);
    this.ignoreDir = path.join(o.workDir, "ignore-empty");
    this.cwd = path.join(o.workDir, "cwd-empty");
    this.stagingRoot = path.join(o.workDir, "staging");
    for (const d of [this.ignoreDir, this.cwd, this.stagingRoot]) {
      ensureOwnerDir(d);
      for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true });
    }
  }

  args(staging: string): string[] {
    return [
      "dir", staging,
      "--config", this.rules,
      "--gitleaks-ignore-path", this.ignoreDir,
      "--ignore-gitleaks-allow",
      "--max-archive-depth", "0",
      "--redact",
      "--report-format", "json",
      "--report-path", "-",
      "--exit-code", "99",
      "--no-banner",
      "--no-color",
      "--log-level", "error",
      "--timeout", String(this.o.timeoutS ?? GITLEAKS_TIMEOUT_S),
    ];
  }

  private env(): NodeJS.ProcessEnv {
    // baseEnv carries neither GITLEAKS_CONFIG nor GITLEAKS_CONFIG_TOML.
    return baseEnv();
  }

  /** Checks the binary's SHA-256 and its version before first use. */
  async verify(): Promise<void> {
    if (this.verified) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(this.o.binary);
    } catch {
      throw new ScanError("The gitleaks binary is missing.");
    }
    if (!st.isFile()) throw new ScanError("The gitleaks path is not a regular file.");
    const key = `${process.platform}-${process.arch}`;
    const expected = this.o.expectSha256 ?? GITLEAKS_BINARY_SHA256[key];
    if (!expected) throw new ScanError(`No pinned gitleaks build for ${key}.`);
    if (sha256Hex(fs.readFileSync(this.o.binary)) !== expected) {
      throw new ScanError(`The gitleaks binary doesn't match the pinned ${GITLEAKS_VERSION} build.`);
    }
    const r = await runFixed(this.o.binary, ["version"], { cwd: this.cwd, env: this.env(), timeoutMs: 30_000 }, this.o.children);
    if (r.code !== 0 || !r.stdout.toString("utf8").trim().split(/\s+/).includes(GITLEAKS_VERSION)) {
      throw new ScanError(`gitleaks didn't report version ${GITLEAKS_VERSION}.`);
    }
    this.verified = true;
  }

  async scan(blobs: Blob[]): Promise<ScanResult> {
    await this.verify();
    if (blobs.length === 0) return { clean: true };
    const staging = fs.mkdtempSync(path.join(this.stagingRoot, "s-"));
    try {
      if (process.platform !== "win32") fs.chmodSync(staging, 0o700);
      for (const b of blobs) {
        if (!/^[0-9a-f]{40,64}$/.test(b.sha)) throw new ScanError("bad blob id");
        fs.writeFileSync(path.join(staging, b.sha), b.content, { mode: 0o600, flag: "wx" });
      }
      const r = await runFixed(this.o.binary, this.args(staging), {
        cwd: this.cwd,
        env: this.env(),
        timeoutMs: ((this.o.timeoutS ?? GITLEAKS_TIMEOUT_S) + 30) * 1000,
      }, this.o.children).catch(() => null);
      if (!r || r.timedOut) throw new ScanError("The secrets scan didn't finish.");
      if (r.code === 0) return { clean: true };
      if (r.code === 99) return { clean: false, ...this.findings(r.stdout, blobs) };
      throw new ScanError(`The secrets scan failed (exit ${r.code ?? r.signal}).`);
    } finally {
      // On Windows a virus scanner can still hold a staged file for a moment. A
      // folder left behind is removed at the next start, and must never turn a
      // finished scan into a failed one.
      try {
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // see above
      }
    }
  }

  /** Maps findings back to blobs by file name; the redacted report holds no secret. */
  private findings(stdout: Buffer, blobs: Blob[]): { blobs: string[]; rules: string[] } {
    const known = new Set(blobs.map((b) => b.sha));
    const hit = new Set<string>();
    const rules = new Set<string>();
    try {
      const report = JSON.parse(stdout.toString("utf8")) as unknown;
      if (Array.isArray(report)) {
        for (const f of report) {
          if (!f || typeof f !== "object") continue;
          const file = (f as Record<string, unknown>).File;
          const rule = (f as Record<string, unknown>).RuleID;
          if (typeof file === "string" && known.has(path.basename(file))) hit.add(path.basename(file));
          if (typeof rule === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(rule)) rules.add(rule);
        }
      }
    } catch {
      // Exit 99 already says there is a finding; an unreadable report still blocks.
    }
    return { blobs: hit.size ? [...hit] : [...known], rules: [...rules] };
  }
}
