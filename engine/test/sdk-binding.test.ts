import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { INTERVIEW_SCHEMAS, fetchPageTool } from "../src/agent/factory-tools";
import { loadAgentSdk, zodShape } from "../src/agent/sdk-binding";
import type { SessionOptions, SpawnOptions } from "../src/agent/sdk";

const SDK_DIR = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk");

describe("Agent SDK 0.3.311 binding", () => {
  it("is the pinned version, and the image's Claude Code checksums are the SDK manifest's", () => {
    expect(JSON.parse(fs.readFileSync(path.join(SDK_DIR, "package.json"), "utf8"))).toMatchObject({ version: "0.3.311", claudeCodeVersion: "2.1.311" });
    const manifest = JSON.parse(fs.readFileSync(path.join(SDK_DIR, "manifest.json"), "utf8"));
    const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docker", "claude-sha256.json"), "utf8"));
    expect(pinned.version).toBe(manifest.version);
    for (const p of ["linux-x64", "linux-arm64"]) expect(pinned[p]).toBe(manifest.platforms[p].checksum);
  });

  it("converts every factory tool's schema for the SDK", async () => {
    for (const [name, s] of Object.entries(INTERVIEW_SCHEMAS)) expect(Object.keys(zodShape(s.schema)), name).toEqual(Object.keys(s.schema.properties as object));
    const shape = zodShape(INTERVIEW_SCHEMAS.interview_ask.schema);
    expect(shape.text!.safeParse("x".repeat(4001)).success).toBe(false);
    expect(shape.suggested!.safeParse(undefined).success).toBe(true);
    const sdk = await loadAgentSdk();
    const tool = fetchPageTool(async () => ({ ok: false, status: 403 }), { maxChars: 10 }, () => undefined);
    expect(sdk.createFactoryServer([tool])).toMatchObject({ type: "sdk", name: "factory" });
  });

  it("never starts Claude Code on the host: the session goes through the engine's spawn, and none is refused", async () => {
    const sdk = await loadAgentSdk();
    const spawned: SpawnOptions[] = [];
    const abort = new AbortController();
    const options = {
      cwd: "/workspace", settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [], allowedTools: [], disallowedTools: [],
      permissionMode: "default", hooks: {}, systemPrompt: "x", plugins: [], maxTurns: 1, env: {}, abortController: abort,
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      spawnClaudeCodeProcess: (o: SpawnOptions) => {
        spawned.push(o);
        const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false, exitCode: null as number | null, kill: () => true });
        setTimeout(() => {
          p.stdout.end();
          p.exitCode = 1;
          p.emit("exit", 1, null);
        }, 10);
        return p as never;
      },
    } as unknown as SessionOptions;
    async function* turns() {
      yield { type: "user" as const, message: { role: "user" as const, content: "hi" }, parent_tool_use_id: null, session_id: "" };
    }
    await expect((async () => {
      for await (const _m of sdk.query({ prompt: turns(), options })) void _m;
    })()).rejects.toThrow();
    expect(spawned).toHaveLength(1);
    // The SDK names its bundled host binary as the command; the engine's spawn ignores it and runs docker exec.
    expect(spawned[0]!.command).toMatch(/claude-agent-sdk-[a-z0-9-]+[\\/]claude(\.exe)?$/);
    for (const a of ["--setting-sources=", "--strict-mcp-config", "--permission-mode=default", "--max-turns=1"]) expect(spawned[0]!.args).toContain(a);
    expect(() => sdk.query({ prompt: turns(), options: { ...options, spawnClaudeCodeProcess: undefined } as never })).toThrow(/container spawn/);
  });
});
