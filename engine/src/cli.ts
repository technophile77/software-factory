import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import YAML from "yaml";
import { checkConfig, engineFile } from "./schemas/config";
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
import { Interview } from "./mcp/operations";
import { ID_RE } from "./mcp/limits";
import { TerminalInterview, type TerminalIo } from "./terminal/interview";
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
  interview [<feature id>] [--project <path>]
          Answers the requirements analyst's questions in this terminal (F-018).
          --project defaults to the current folder, inside the project's repo.
          Started by the software-factory plugin, not by hand.
  inbox [<item id>] [--project <path>]
          Lists the project's open inbox items and answers them in this terminal
          (F-021). Every item is still a GitHub issue; the first answer counts.
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
  const doc = YAML.parse(fs.readFileSync(file, "utf8"), { uniqueKeys: true, maxAliasCount: 0 }) as unknown;
  if (doc === null) return {};
  checkConfig("engine.yaml", doc, engineFile);
  const g = (doc as { gitleaks?: string }).gitleaks;
  return g ? { gitleaks: g } : {};
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

/** A spinner with the elapsed time, redrawn in place on stdout until stopped (F-018 FR-14). */
function spinner(label: string, delayMs: number, ascii: boolean): () => void {
  const frames = ascii ? ["|", "/", "-", "\\"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const start = Date.now();
  let n = 0;
  let drawn = false;
  const draw = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r\x1b[2K${frames[n++ % frames.length]} ${label} (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`);
    drawn = true;
  };
  let timer: NodeJS.Timeout | undefined;
  const begin = setTimeout(() => {
    draw();
    timer = setInterval(draw, 100);
  }, delayMs);
  return () => {
    clearTimeout(begin);
    if (timer) clearInterval(timer);
    if (drawn) process.stdout.write("\r\x1b[2K");
  };
}

/** Lines from the terminal. Ctrl+C or Ctrl+D ends input, so the session is closed before exit (FR-9). */
function terminalIo(ascii: boolean): TerminalIo & { close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
  let ended = false;
  let pending: ((l: string | null) => void) | null = null;
  const end = () => {
    ended = true;
    pending?.(null);
    pending = null;
  };
  rl.on("close", end);
  rl.on("SIGINT", () => {
    process.stdout.write("\nStopping.\n");
    rl.close();
  });
  process.once("SIGTERM", () => rl.close());
  return {
    write: (t) => process.stdout.write(t),
    line: (prompt) => new Promise((resolve) => {
      if (ended) return resolve(null);
      pending = resolve;
      rl.question(prompt, (a) => {
        pending = null;
        resolve(a);
      });
    }),
    close: () => rl.close(),
    busy: (label, delayMs) => spinner(label, delayMs, ascii),
    aborted: () => ended,
  };
}

/** `interview` (F-018) and `inbox` (F-021) share their checks and their terminal. */
async function interview(rest: string[], command: "interview" | "inbox" = "interview"): Promise<number> {
  const feature = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  let f: Record<string, string>;
  try {
    f = flags(feature ? rest.slice(1) : rest);
  } catch {
    process.stderr.write(USAGE);
    return 2;
  }
  const idOk = command === "inbox" ? /^[DTHSMN]-\d{4,8}$/ : ID_RE;
  if (Object.keys(f).some((k) => k !== "project") || (feature !== undefined && !idOk.test(feature))) {
    process.stderr.write(USAGE);
    return 2;
  }
  // A script or a model's shell tool must not type answers for the owner (SR-3).
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`factory-engine ${command} runs only in a terminal, with you typing the answers.\n`);
    return 2;
  }
  const ops = new Interview({ os: realOsApi(), projectDir: path.resolve(f.project ?? process.cwd()) });
  // Windows consoles without Windows Terminal may not draw box characters.
  const ascii = process.platform === "win32" && !process.env.WT_SESSION;
  const marker = ascii ? "| " : "\u2502 ";
  const io = terminalIo(ascii);
  try {
    const t = new TerminalInterview((op, req) => ops.run(op, req), io, marker);
    return await (command === "inbox" ? t.inboxMain(feature) : t.main(feature));
  } finally {
    io.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "interview") return interview(rest);
  if (cmd === "inbox") return interview(rest, "inbox");
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
