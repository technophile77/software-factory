import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir, writeFileAtomic } from "./fsutil";
import { Children, RunResult, baseEnv, runFixed } from "./proc";

export class GitError extends Error {
  override name = "GitError";
}

/**
 * Overrides on every git command the engine runs (SR-11). Repo config can
 * otherwise make git run programs on the host: hooks (including husky's
 * hooksPath), fsmonitor, and remote helpers. Filters and textconv only run
 * from porcelain that converts content, which the engine avoids: it writes
 * with `hash-object --no-filters`, `update-index --cacheinfo`, `commit-tree`
 * and `update-ref`, and reads with `cat-file blob` and `ls-tree`.
 */
export function overrideArgs(hooksDir: string, attributesFile: string): string[] {
  return [
    "-c", `core.hooksPath=${hooksDir}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.attributesFile=${attributesFile}`,
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.file.allow=never",
    "-c", "credential.helper=",
    "-c", "core.askPass=",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "core.pager=cat",
  ];
}

export interface GitOptions {
  gitPath: string;
  /** Engine-owned folder for the empty hooks dir, empty config and askpass helper. */
  homeDir: string;
  children: Children;
  env?: NodeJS.ProcessEnv;
}

export interface GitRunOptions {
  input?: Buffer | string;
  indexFile?: string;
  /** Exit codes that are answers rather than failures (for example 1 from show-ref). */
  okCodes?: number[];
  askpassToken?: string;
  timeoutMs?: number;
}

export class Git {
  readonly hooksDir: string;
  private readonly attributesFile: string;
  private readonly globalConfig: string;
  private readonly askpass: string;

  constructor(private readonly opts: GitOptions) {
    if (!path.isAbsolute(opts.gitPath)) throw new GitError("git must be named by absolute path");
    ensureOwnerDir(opts.homeDir);
    this.hooksDir = path.join(opts.homeDir, "hooks-empty");
    ensureOwnerDir(this.hooksDir);
    for (const f of fs.readdirSync(this.hooksDir)) fs.rmSync(path.join(this.hooksDir, f), { recursive: true, force: true });
    this.attributesFile = path.join(opts.homeDir, "attributes-empty");
    this.globalConfig = path.join(opts.homeDir, "gitconfig-empty");
    writeFileAtomic(this.attributesFile, "");
    writeFileAtomic(this.globalConfig, "");
    // The token reaches git through the environment of this one helper, never
    // an argument or URL (SR-11). Git for Windows runs it through its own sh.
    this.askpass = path.join(opts.homeDir, "askpass.sh");
    writeFileAtomic(this.askpass, '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' x-access-token ;;\n  *) printf \'%s\\n\' "$FACTORY_GIT_TOKEN" ;;\nesac\n');
    if (process.platform !== "win32") fs.chmodSync(this.askpass, 0o700);
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...baseEnv(this.opts.env),
      HOME: this.opts.homeDir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Software Factory Engine",
      GIT_AUTHOR_EMAIL: "engine@software-factory.invalid",
      GIT_COMMITTER_NAME: "Software Factory Engine",
      GIT_COMMITTER_EMAIL: "engine@software-factory.invalid",
      ...extra,
    };
  }

  args(cwd: string, args: string[]): string[] {
    return ["-C", cwd, ...overrideArgs(this.hooksDir, this.attributesFile), ...args];
  }

  async run(cwd: string, args: string[], o: GitRunOptions = {}): Promise<RunResult> {
    const extra: NodeJS.ProcessEnv = {};
    if (o.indexFile) extra.GIT_INDEX_FILE = o.indexFile;
    let full = this.args(cwd, args);
    if (o.askpassToken !== undefined) {
      extra.GIT_ASKPASS = this.askpass;
      extra.FACTORY_GIT_TOKEN = o.askpassToken;
      full = full.map((a) => (a === "core.askPass=" ? `core.askPass=${this.askpass}` : a));
    }
    const res = await runFixed(this.opts.gitPath, full, {
      cwd,
      env: this.env(extra),
      input: o.input,
      timeoutMs: o.timeoutMs ?? 120_000,
    }, this.opts.children);
    if (res.code !== 0 && !(res.code !== null && o.okCodes?.includes(res.code))) {
      // stderr can quote paths and refs but never secrets: tokens only travel in the askpass env.
      throw new GitError(`git ${args[0]} failed (${res.timedOut ? "timeout" : res.code ?? res.signal}): ${res.stderr.trim().split("\n")[0] ?? ""}`);
    }
    return res;
  }

  async out(cwd: string, args: string[], o: GitRunOptions = {}): Promise<string> {
    return (await this.run(cwd, args, o)).stdout.toString("utf8").trim();
  }

  async revParse(cwd: string, ref: string): Promise<string | null> {
    const r = await this.run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { okCodes: [1] });
    const sha = r.stdout.toString().trim();
    return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  /** The blob at `spec` (`<commit>:<path>`), refusing anything but a regular file entry. */
  async readBlob(cwd: string, commit: string, file: string): Promise<Buffer | null> {
    const entry = await this.lsTreeEntry(cwd, commit, file);
    if (!entry) return null;
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new GitError(`${file} is not a regular file in git`);
    }
    return this.catBlob(cwd, entry.sha);
  }

  async catBlob(cwd: string, sha: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError("bad blob id");
    // `cat-file blob` applies no textconv, filters or attributes.
    return (await this.run(cwd, ["cat-file", "blob", sha])).stdout;
  }

  /**
   * Several blobs from one `cat-file --batch`, which like `cat-file blob`
   * applies no textconv or filters. One process instead of one per file:
   * each spawn costs tens of milliseconds, far more on Windows.
   */
  async catBlobs(cwd: string, shas: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const want = [...new Set(shas)];
    if (!want.length) return out;
    if (!want.every((s) => /^[0-9a-f]{40,64}$/.test(s))) throw new GitError("bad blob id");
    const buf = (await this.run(cwd, ["cat-file", "--batch"], { input: want.join("\n") + "\n" })).stdout;
    let at = 0;
    for (const sha of want) {
      const nl = buf.indexOf(0x0a, at);
      const m = nl < 0 ? null : /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(buf.subarray(at, nl).toString("utf8"));
      if (!m || m[1] !== sha || m[2] !== "blob") throw new GitError(`blob ${sha.slice(0, 12)} couldn't be read`);
      const end = nl + 1 + Number(m[3]);
      if (end > buf.length) throw new GitError(`blob ${sha.slice(0, 12)} was cut short`);
      out.set(sha, Buffer.from(buf.subarray(nl + 1, end)));
      at = end + 1;
    }
    return out;
  }

  async lsTreeEntry(cwd: string, commit: string, file: string): Promise<{ mode: string; type: string; sha: string } | null> {
    const r = await this.run(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", file]);
    const line = r.stdout.toString("utf8").split("\0").find((l) => l.length > 0);
    if (!line) return null;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
    if (!m || m[4] !== file) return null;
    return { mode: m[1]!, type: m[2]!, sha: m[3]! };
  }

  /** Every entry under `dir` (recursively), as `{ mode, type, sha, path }`. */
  async lsTree(cwd: string, commit: string, dir?: string): Promise<Array<{ mode: string; type: string; sha: string; path: string }>> {
    const args = ["ls-tree", "-r", "-z", "--full-tree", commit];
    if (dir) args.push("--", dir);
    const r = await this.run(cwd, args);
    const out = [];
    for (const line of r.stdout.toString("utf8").split("\0")) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
      if (m) out.push({ mode: m[1]!, type: m[2]!, sha: m[3]!, path: m[4]! });
    }
    return out;
  }
}
