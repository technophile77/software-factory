// The Agent SDK as the engine sees it (README "In-process API", `agents`),
// played by the test: no model, no Claude Code. Each session the engine
// starts runs a behaviour the test gives for its role. A behaviour acts the
// way the real agent can: it calls the engine's `factory` tools, and it
// changes files only by starting "Claude Code" through the engine's own
// spawn, which runs inside the container (`docker exec`), so every write
// goes through the container's mounts.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeDocker, type ExecAction } from "./fake-docker";
import { REPO_ROOT } from "./world";

interface FactoryTool {
  name: string;
  handler(args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export type Role = "analyst" | "reader" | "reviewer";

export interface ToolCall {
  isError: boolean;
  value: any;
}

export class FakeSession {
  result = "done";
  /** What the session returns as its structured result (F-020 FR-9), when the engine gave it a schema. */
  structured: unknown = undefined;
  readonly id = "fake-" + randomBytes(6).toString("hex");
  /** What each tool call returned to the agent, in order: everything that reached it. */
  readonly received: Array<{ tool: string; text: string }> = [];

  constructor(
    readonly role: Role,
    readonly options: any,
    private readonly tools: FactoryTool[],
    private readonly prompt: AsyncIterator<{ message: { content: string } }>,
    private readonly docker: FakeDocker | null,
  ) {}

  /** The names of the `factory` tools this session was given. */
  get toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  async call(name: string, args: unknown): Promise<ToolCall> {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new Error(`session has no factory tool ${name} (has ${this.toolNames.join(", ")})`);
    const r = await t.handler(args);
    const text = r.content.map((c) => c.text).join("");
    this.received.push({ tool: name, text });
    let value: any = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain text, e.g. a label before the JSON.
    }
    return { isError: !!r.isError, value };
  }

  /** The next user turn the engine hands the agent, or null when it closes them. */
  async nextTurn(): Promise<string | null> {
    const r = await this.prompt.next();
    return r.done ? null : r.value.message.content;
  }

  /**
   * Starts Claude Code through the engine's spawn, as the SDK does, with
   * the arguments the SDK derives from the session options. With the fake
   * Docker, `actions` are what the agent then does in its container. Resolves
   * with the exit code.
   */
  async exec(actions: ExecAction[] = []): Promise<number | null> {
    if (this.docker) this.docker.set({ exec: actions });
    const o = this.options;
    const args = [
      "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
      `--setting-sources=${(o.settingSources ?? []).join(",")}`,
      ...(o.strictMcpConfig ? ["--strict-mcp-config"] : []),
      "--permission-mode", String(o.permissionMode),
    ];
    const child = o.spawnClaudeCodeProcess({
      command: "claude",
      args,
      env: { ...o.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
      signal: o.abortController.signal,
    });
    child.stdin.end();
    child.stdout.resume();
    return new Promise((resolve) => child.once("exit", (code: number | null) => resolve(code)));
  }
}

export type Behaviour = (s: FakeSession) => Promise<void>;

/** The engine's AgentSdk, with each role's behaviour set by the test. */
export class FakeSdk {
  readonly sessions: FakeSession[] = [];
  behaviours: Partial<Record<Role, Behaviour>> = {};

  constructor(private readonly docker: FakeDocker | null) {}

  createFactoryServer(tools: FactoryTool[]): unknown {
    return { fakeTools: tools };
  }

  query(p: { prompt: AsyncIterable<any>; options: any }): AsyncIterable<any> {
    const tools: FactoryTool[] = p.options.mcpServers?.factory?.fakeTools ?? [];
    // The reader's only factory tool is fetch_page (Role policy v2.5); the analyst's are the interview tools;
    // the Security and Testability Review security reviewer (F-008) has none, as it only returns its report.
    const role: Role = tools.some((t) => t.name === "fetch_page") ? "reader" : tools.some((t) => t.name.startsWith("interview_")) ? "analyst" : "reviewer";
    const s = new FakeSession(role, p.options, tools, p.prompt[Symbol.asyncIterator](), this.docker);
    this.sessions.push(s);
    const behaviour = this.behaviours[role];
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: s.id, tools: p.options.tools };
      if (behaviour) await behaviour(s);
      yield {
        type: "result", subtype: "success", session_id: s.id, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, result: s.result,
        ...(p.options.outputFormat && s.structured !== undefined ? { structured_output: s.structured } : {}),
      };
    })();
  }

  of(role: Role): FakeSession[] {
    return this.sessions.filter((s) => s.role === role);
  }
}

/** The engine's own image files (its `docker/` folder), which the image build copies. */
export const ENGINE_DOCKER_DIR = join(REPO_ROOT, "engine", "docker");

/** The engine's `agents` runtime on the fake Docker. */
export async function fakeRuntime(dir: string, docker: FakeDocker, sdk: FakeSdk, proxyScript: string) {
  return { docker: await dockerCli(docker.path, docker.host, join(dir, "docker-config")), sdk: async () => sdk, dockerDir: ENGINE_DOCKER_DIR, proxyScript };
}

const srcModule = (p: string) => fileURLToPath(new URL(`../../../src/${p}.ts`, import.meta.url));

/** The engine's docker command line (SR-14), as the CLI builds it, for a given client and local endpoint. */
export async function dockerCli(dockerPath: string, host: string, configDir: string): Promise<any> {
  const [{ DockerCli }, { Children }] = await Promise.all(["docker/cli", "proc"].map((m) => import(/* @vite-ignore */ srcModule(m))));
  return new DockerCli({ dockerPath, host, configDir, children: new Children() });
}
