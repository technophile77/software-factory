// One test's world for the MCP mode suites: a git repo whose `.factory` is the
// `factory/state` linked worktree, a fake engine named in its engine.json, and
// an MCP mode process started with CLAUDE_PROJECT_DIR set to the repo.

import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";
import { FakeEngine, type Json } from "./mcp-fake-engine";
import { Ops, type ToolResult, type Traffic, expectCleanFailure, expectNothingSent, expectOk, makeRepo, traffic, writeEngineJson } from "./mcp-harness";

export interface WorldOptions {
  layout?: "state" | "plain" | "none";
  version?: string;
  capabilities?: string[] | null;
  /** v1.2 GitHub approval on open; null models a v1.1 engine. */
  approval?: boolean;
}

export class McpWorld {
  engine!: FakeEngine;
  mcp!: Ops;
  root!: string;
  repo!: string;
  factory!: string;
  before: Traffic = { connections: 0, requests: 0 };
  private extra: Ops[] = [];
  private engines: FakeEngine[] = [];

  constructor(readonly bundle: string, readonly o: WorldOptions = {}) {}

  static async create(bundle: string, o: WorldOptions = {}): Promise<McpWorld> {
    const w = new McpWorld(bundle, o);
    ({ root: w.root, repo: w.repo, factory: w.factory } = makeRepo(o.layout ?? "state"));
    w.engine = await w.startEngine();
    w.mcp = await Ops.start(bundle, w.repo);
    return w;
  }

  get version(): string {
    return this.o.version ?? (this.o.approval === false ? "1.1" : "1.4");
  }

  async startEngine(state?: FakeEngine): Promise<FakeEngine> {
    const e = await FakeEngine.start(state);
    this.engines.push(e);
    e.version = this.version;
    e.capabilities = this.o.capabilities === null ? [] : (this.o.capabilities ?? ["document"]);
    if (this.o.approval === false) e.approval = null;
    if ((this.o.layout ?? "state") === "state") this.writeEngineJson(e.path);
    return e;
  }

  writeEngineJson(address: string, extra: Record<string, Json> = {}, where = this.factory): string {
    const caps = this.o.capabilities === null ? undefined : (this.o.capabilities ?? ["document"]);
    return writeEngineJson(where, address, { version: this.version, capabilities: caps, ...extra });
  }

  /** Calls a tool on this world's MCP mode (or `on`), noting the engine traffic before it. */
  async call(tool: string, args: Record<string, unknown> = {}, on: Ops = this.mcp): Promise<ToolResult> {
    this.before = traffic(this.engine);
    return on.call(`interview_${tool}`, args);
  }

  expectRefusedBeforeConnecting(r: ToolResult, reason?: RegExp): Json {
    const err = expectCleanFailure(r);
    expectNothingSent(this.engine, this.before);
    if (reason) expect(`${err.message}\n${r.out.display ?? ""}`).toMatch(reason);
    return err;
  }

  /** Opens `feature` and passes its GitHub approval, as the skill does. Returns open's result. */
  async open(feature = "F-1", extra: Record<string, unknown> = {}, on: Ops = this.mcp): Promise<Json> {
    const out = expectOk(await this.call("open", { feature, ...extra }, on));
    if (out.approval) expectOk(await this.call("approval", { feature, wait_s: 0 }, on));
    return out;
  }

  reply(item: string, kind: string, text: string, extra: Record<string, unknown> = {}, on: Ops = this.mcp): Promise<ToolResult> {
    return this.call("reply", { feature: "F-1", item, revision: 0, status: "open", kind, text, ...extra }, on);
  }

  async next(extra: Record<string, unknown> = {}, feature = "F-1"): Promise<Json> {
    return expectOk(await this.call("next", { feature, ...extra }));
  }

  /** A second MCP mode process, as another Claude Code session would start. */
  async another(): Promise<Ops> {
    const m = await Ops.start(this.bundle, this.repo);
    this.extra.push(m);
    return m;
  }

  /** Every token the fake engine ever issued. */
  tokens(): string[] {
    return this.engine.requests.flatMap((r) => (typeof r.msg.params?.session === "string" ? [r.msg.params.session] : []));
  }

  oneQuestion(extra: Record<string, Json> = {}): void {
    this.engine.addFeature("F-1", "Export reports", [{ id: "Q1", revision: 0, kind: "question", text: "What should Q1 be?", why: "Q1 decides the scope.", status: "open", ...extra }]);
  }

  async cleanup(): Promise<void> {
    await this.mcp?.close();
    for (const m of this.extra) await m.close();
    for (const e of this.engines) await e.cleanup();
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
  }

  file(...parts: string[]): string {
    return path.join(this.repo, ...parts);
  }
}
