import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureOwnerDir } from "../fsutil";
import { Children, RunResult, baseEnv, runFixed } from "../proc";

export class DockerError extends Error {
  override name = "DockerError";
}

/** Names the engine gives networks, containers and volumes: built from validated ids only (SR-14). */
export const DOCKER_NAME_RE = /^factory-[a-z0-9][a-z0-9-]{0,100}$/;

export function dockerName(...parts: string[]): string {
  const name = ["factory", ...parts.map((p) => p.toLowerCase())].join("-");
  if (!DOCKER_NAME_RE.test(name) || parts.some((p) => !/^[A-Za-z0-9-]{1,64}$/.test(p))) throw new DockerError("bad docker name");
  return name;
}

/**
 * The local daemon endpoints the engine will use, in order (SR-14's fixed
 * local context). A remote endpoint is never used, whatever the owner's
 * Docker config or environment says.
 */
export function localEndpoints(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home = os.homedir()): string[] {
  if (platform === "win32") return ["npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/docker_engine"];
  if (platform === "darwin") return [`unix://${path.join(home, ".docker", "run", "docker.sock")}`, "unix:///var/run/docker.sock"];
  const out: string[] = [];
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg)) out.push(`unix://${path.join(xdg, "docker.sock")}`);
  out.push(`unix://${path.join(home, ".docker", "desktop", "docker.sock")}`, "unix:///var/run/docker.sock");
  return out;
}

export function isLocalEndpoint(host: string): boolean {
  return /^unix:\/\/\/[^\0]+$/.test(host) || /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]{1,100}$/.test(host);
}

export interface DockerOptions {
  /** The docker client, by absolute path. */
  dockerPath: string;
  /** One of localEndpoints(): passed as --host, so no context or DOCKER_HOST applies. */
  host: string;
  /** Engine-owned folder used as DOCKER_CONFIG, so the owner's ~/.docker (contexts, proxies, credential helpers) never applies. */
  configDir: string;
  children: Children;
  env?: NodeJS.ProcessEnv;
}

export interface DockerRunOptions {
  input?: string | Buffer;
  timeoutMs?: number;
  okCodes?: number[];
  /** Extra variables for the docker client, for `-e NAME` flags that take their value from it, so a value never sits in an argument. */
  env?: Record<string, string>;
}

/**
 * The docker command line, run as SR-14 sets out: absolute path, argument
 * array, no shell, DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG and DOCKER_TLS*
 * cleared, and a fixed local endpoint.
 */
export class DockerCli {
  constructor(private readonly o: DockerOptions) {
    if (!path.isAbsolute(o.dockerPath)) throw new DockerError("docker must be named by absolute path");
    if (!isLocalEndpoint(o.host)) throw new DockerError("only a local docker endpoint is used");
    ensureOwnerDir(o.configDir);
    // An empty config: no currentContext, proxies, credsStore or plugins from the owner's.
    fs.writeFileSync(path.join(o.configDir, "config.json"), "{}\n", { mode: 0o600 });
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = baseEnv(this.o.env);
    // The client must not send the engine's own proxy settings to the daemon or into containers.
    for (const k of Object.keys(env)) if (/^(https?|no)_proxy$/i.test(k)) delete env[k];
    for (const k of Object.keys(extra)) if (/^DOCKER_/i.test(k)) throw new DockerError("DOCKER_* may not be passed");
    return { ...env, DOCKER_CONFIG: this.o.configDir, ...extra };
  }

  args(args: string[]): string[] {
    return ["--host", this.o.host, ...args];
  }

  async run(args: string[], o: DockerRunOptions = {}): Promise<RunResult> {
    const res = await runFixed(this.o.dockerPath, this.args(args), {
      cwd: this.o.configDir,
      env: this.env(o.env),
      input: o.input,
      timeoutMs: o.timeoutMs ?? 120_000,
      maxStdout: 16 * 1024 * 1024,
    }, this.o.children);
    if (res.code !== 0 && !(res.code !== null && o.okCodes?.includes(res.code))) {
      throw new DockerError(`docker ${args[0]} failed (${res.timedOut ? "timeout" : res.code ?? res.signal}): ${res.stderr.trim().split("\n")[0]?.slice(0, 300) ?? ""}`);
    }
    return res;
  }

  async out(args: string[], o: DockerRunOptions = {}): Promise<string> {
    return (await this.run(args, o)).stdout.toString("utf8").trim();
  }

  /** A long-lived docker process with its stdio piped (the agent session's `docker exec -i`, the proxy's `docker start -ai`). */
  spawn(args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
    const child = spawn(this.o.dockerPath, this.args(args), {
      cwd: this.o.configDir,
      env: this.env(extraEnv),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) {
      const pid = child.pid;
      this.o.children.add(pid);
      child.once("exit", () => this.o.children.remove(pid));
    }
    return child;
  }
}

/** The first endpoint whose socket or pipe exists; null means no local daemon, so no session starts (AC-13). */
export function pickEndpoint(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string | null {
  const local = (e: string) => (e.startsWith("npipe:") ? `\\\\.\\pipe\\${e.slice("npipe:////./pipe/".length)}` : e.slice("unix://".length));
  return localEndpoints(platform, env).find((e) => exists(local(e))) ?? null;
}
