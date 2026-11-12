import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import YAML from "yaml";
import { systemClock } from "./clock";
import type { AgentRuntime } from "./agent/runtime";
import { loadAgentSdk } from "./agent/sdk-binding";
import { confirmProject } from "./config/confirm";
import { DockerCli, DockerError, pickEndpoint } from "./docker/cli";
import { PinStore } from "./config/pins";
import { defaultEngineHome, startEngine } from "./engine";
import { ensureOwnerDir, findOnPath } from "./fsutil";
import { Git } from "./git";
import { HttpGitHub } from "./github";
import { FileLogger } from "./log";
import { realOsApi } from "./os/ffi";
import { Children } from "./proc";
import { OsCredentialStore, SecretError, isSecretName } from "./secrets";

const USAGE = `factory-engine <command>

  start   [--master <master repo clone>] [--home <engine folder>] [--gitleaks <path>]
          Runs the engine. --master defaults to the current folder.
  confirm --project <config repo path> [--master <path>] [--home <path>]
          Accepts a changed or new project after a GitHub device approval (SR-5).
  secret set <name>
          Stores a secret in the OS credential store, read from stdin.
          Names: model-credential, factory-token/<project name>.
`;

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--") || i + 1 >= args.length) throw new Error(`Unexpected argument ${a}`);
    out[a.slice(2)] = args[++i]!;
  }
  return out;
}

/**
 * Docker on a fixed local endpoint (SR-14) and the Agent SDK, loaded only when
 * a session starts. With no docker client or local daemon, every session is
 * refused with that reason, and the owner sees it in the transcript (AC-13).
 */
async function agentRuntime(home: string): Promise<AgentRuntime> {
  const dockerPath = findOnPath(process.platform === "win32" ? "docker.exe" : "docker");
  const host = await pickEndpoint(process.platform, process.env);
  const missing = !dockerPath ? "no docker client is on PATH" : !host ? "no local Docker daemon was found" : null;
  const refuse = async (): Promise<never> => {
    throw new DockerError(`Docker isn't available: ${missing}`);
  };
  const docker = missing
    ? ({ run: refuse, out: refuse, spawn: () => { throw new DockerError(`Docker isn't available: ${missing}`); } } as unknown as DockerCli)
    : new DockerCli({ dockerPath: dockerPath!, host: host!, configDir: path.join(home, "docker"), children: new Children() });
  // The bundle sits in dist/; the image's fixed files ship beside it in docker/.
  return { docker, sdk: loadAgentSdk, dockerDir: path.join(__dirname, "..", "docker"), proxyScript: path.join(__dirname, "proxy.js") };
}

/** The engine's own config, outside every repo: today only the gitleaks path. */
function engineConfig(home: string): { gitleaks?: string } {
  const file = path.join(home, "engine.yaml");
  if (!fs.existsSync(file)) return {};
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!doc || typeof doc !== "object") return {};
  const g = (doc as Record<string, unknown>).gitleaks;
  return typeof g === "string" ? { gitleaks: g } : {};
}

/** Reads a secret without echoing it, so it never lands on a command line or in shell history (SR-1). */
async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write("Paste the secret, then press Enter (it isn't shown): ");
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "secret") {
    const [sub, name] = rest;
    if (sub !== "set" || !name || !isSecretName(name)) {
      process.stderr.write(USAGE);
      return 2;
    }
    const store = new OsCredentialStore(() => realOsApi().credentials());
    try {
      await store.set(name, await readSecret());
    } catch (e) {
      process.stderr.write(`${e instanceof SecretError ? e.message : "The secret couldn't be stored."}\n`);
      return 1;
    }
    process.stderr.write(`Stored ${name}.\n`);
    return 0;
  }
  if (cmd !== "start" && cmd !== "confirm") {
    process.stderr.write(USAGE);
    return cmd === "--help" ? 0 : 2;
  }
  const f = flags(rest);
  const home = f.home ? path.resolve(f.home) : defaultEngineHome();
  ensureOwnerDir(home);
  const master = path.resolve(f.master ?? process.cwd());
  if (cmd === "confirm") {
    if (!f.project) {
      process.stderr.write(USAGE);
      return 2;
    }
    const log = new FileLogger(path.join(home, "logs"), systemClock);
    const gitPath = findOnPath("git");
    if (!gitPath) throw new Error("git isn't on PATH");
    const git = new Git({ gitPath, homeDir: path.join(home, "git"), children: new Children() });
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ok = await confirmProject({
        masterRepo: master, projectPath: path.resolve(f.project), git, github: new HttpGitHub({ log }),
        pins: new PinStore(home), os: realOsApi(), clock: systemClock, log,
        io: { say: (l) => process.stderr.write(l + "\n"), ask: (q) => new Promise((r) => rl.question(q, r)) },
      });
      return ok ? 0 : 1;
    } finally {
      rl.close();
    }
  }
  const gitleaks = f.gitleaks ?? engineConfig(home).gitleaks;
  if (!gitleaks || !path.isAbsolute(gitleaks)) {
    process.stderr.write("Give the gitleaks binary's absolute path with --gitleaks or `gitleaks:` in engine.yaml.\n");
    return 2;
  }
  const engine = await startEngine({ masterRepo: master, engineHome: home, gitleaks: { path: gitleaks }, push: true, agents: await agentRuntime(home) });
  for (const p of engine.projects) {
    process.stderr.write(`${p.name ?? p.path}: ${p.state}${p.reason ? ` (${p.reason})` : ""}\n`);
  }
  const stop = () => void engine.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await engine.stopped;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`factory-engine: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
