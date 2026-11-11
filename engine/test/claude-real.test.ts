// H1 (Security Gate 2): the tool gate against the real Claude Code binary
// from the SDK package. In permissionMode "default" Claude Code approves
// reads inside its working folder and read-only Bash without asking
// canUseTool, so only a run of the real binary shows that the engine's
// PreToolUse hook stops them. The binary runs on the host here, in a scratch
// folder, against a local fake Messages API with a dummy key: no real
// credential and no network beyond loopback. The same run checks that the
// gateway's M1 rules (beta allow-list, no server-side tools) fit what this
// CLI really sends.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { SpawnOptions, SpawnedProcess } from "../src/agent/sdk";
import { loadAgentSdk } from "../src/agent/sdk-binding";
import { CONTAINER_FLAGS, runSession, sessionOptions } from "../src/agent/session";
import { MemoryLogger } from "../src/log";
import { ALLOWED_BETAS, refusedBody } from "../src/proxy/server";
import { SECRET_DENIES, type RolePolicy } from "../src/policy/role-policy";
import { tmpdir } from "./helpers";

const BIN = path.join(__dirname, "..", "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude");
// The gate maps the container's POSIX paths; on a Windows host Claude Code only ever runs inside the Linux container.
const runnable = process.platform !== "win32" && fs.existsSync(BIN);
const SECRET = "TOPSECRET-4d1f";

interface Step {
  name: string;
  input: Record<string, unknown>;
}

/** A Messages API that answers each turn with the next scripted tool call, and records every request body. */
async function fakeApi(steps: Step[]) {
  const bodies: string[] = [];
  const betas = new Set<string>();
  let n = 0;
  const sse = (res: http.ServerResponse, block: Record<string, unknown>, stop: string) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (t: string, d: Record<string, unknown>) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    if (block.type === "text") {
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
    } else {
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${n}`, name: block.name, input: {} } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    ev("message_stop", {});
    res.end();
  };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      bodies.push(body);
      for (const b of String(req.headers["anthropic-beta"] ?? "").split(",")) if (b.trim()) betas.add(b.trim());
      const json = (o: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) return json({ input_tokens: 1 });
      let j: { stream?: boolean; tools?: unknown[]; messages?: unknown[] } = {};
      try {
        j = JSON.parse(body);
      } catch {
        // answered as a plain message below
      }
      if (!j.stream) return json({ id: "m", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      const afterTool = JSON.stringify(j.messages?.slice(1) ?? []).includes("tool_result");
      if (j.tools && n < steps.length && (n === 0 || afterTool)) return sse(res, { type: "tool_use", ...steps[n++] }, "tool_use");
      return sse(res, { type: "text", text: "done" }, "end_turn");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { port, bodies, betas, done: () => n, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** The tool_result text for each tool_use id, from the last request that carried them all. */
function toolResults(bodies: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bodies) {
    let j: { messages?: Array<{ content?: unknown }> };
    try {
      j = JSON.parse(b);
    } catch {
      continue;
    }
    for (const m of j.messages ?? []) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (c.type === "tool_result" && c.tool_use_id) out.set(c.tool_use_id, JSON.stringify(c.content ?? ""));
      }
    }
  }
  return out;
}

describe.skipIf(!runnable)(`H1: the tool gate holds against the real Claude Code binary${runnable ? "" : " (skipped: no host binary for this platform in the SDK package, or Windows)"}`, () => {
  it("denies Read, Grep, Glob and Bash on denied paths even where Claude Code would approve them itself", { timeout: 180_000 }, async () => {
    const ws = tmpdir();
    const home = tmpdir();
    fs.writeFileSync(path.join(ws, ".env"), `API_TOKEN=${SECRET}\n`);
    fs.mkdirSync(path.join(ws, "private"));
    fs.writeFileSync(path.join(ws, "private", "plan.md"), `${SECRET}\n`);
    fs.writeFileSync(path.join(ws, "notes.md"), "NOTES-OK\n");
    const policy: RolePolicy = {
      role: "requirements-analyst",
      tools: ["Read", "Grep", "Glob", "Bash"],
      read: { allow: ["**"], deny: [...SECRET_DENIES, "private", "private/**"] },
      write: { allow: [], deny: [] },
      commands: ["ls"],
      network: [],
      mayRequest: [],
    };
    const steps: Step[] = [
      { name: "Read", input: { file_path: `${ws}/.env` } },
      { name: "Grep", input: { pattern: "TOPSECRET", output_mode: "content" } },
      { name: "Glob", input: { pattern: "*", path: `${ws}/private` } },
      { name: "Bash", input: { command: "cat .env", description: "show" } },
      { name: "Read", input: { file_path: `${ws}/notes.md` } },
      { name: "Bash", input: { command: "ls", description: "list" } },
    ];
    const api = await fakeApi(steps);
    try {
      const sdk = await loadAgentSdk();
      const log = new MemoryLogger();
      const abort = new AbortController();
      const spawnLocal = (o: SpawnOptions): SpawnedProcess => {
        const child = spawn(BIN, o.args, {
          cwd: ws,
          env: {
            // As in the container: only what the SDK sets for its protocol and the fixed flags, nothing of this process.
            ...Object.fromEntries(Object.entries(o.env).filter(([k]) => /^(CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_SDK_READS_SESSION_STATE)$/.test(k) || k in CONTAINER_FLAGS)),
            PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: "sk-ant-placeholder-not-a-key",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        o.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
        return child as unknown as SpawnedProcess;
      };
      const opts = sessionOptions({
        policy, worktree: ws, workspace: ws, cwd: ws, instructions: "Test session.", factoryServer: sdk.createFactoryServer([]), factoryTools: [],
        caps: { maxTurns: 20, maxBudgetUsd: 5, wallTimeMs: 150_000 }, spawn: spawnLocal, log,
      }, abort);
      async function* turns() {
        yield { type: "user" as const, message: { role: "user" as const, content: "go" }, parent_tool_use_id: null, session_id: "" };
      }
      await runSession(sdk, opts, turns(), { maxTurns: 20, maxBudgetUsd: 5, wallTimeMs: 150_000 }, { onSessionId: () => undefined, onWebSearch: () => undefined });
      expect(api.done(), "every scripted tool call was made").toBe(steps.length);
      const results = toolResults(api.bodies);
      const r = (i: number) => results.get(`toolu_${i + 1}`) ?? "";
      for (const i of [0, 1, 2, 3]) expect(r(i), `${steps[i]!.name} ${JSON.stringify(steps[i]!.input)}`).toMatch(/Refused by the factory engine/);
      expect(r(4)).toContain("NOTES-OK");
      expect(r(5)).toContain("notes.md");
      // M1: the gateway would pass this CLI's requests as they are. A new beta here means ALLOWED_BETAS needs the owner's review.
      expect([...api.betas].filter((b) => !ALLOWED_BETAS.has(b))).toEqual([]);
      for (const b of api.bodies) expect(refusedBody(Buffer.from(b))).toBeNull();
      for (const b of api.bodies) expect(b.includes(SECRET), "a denied file's content reached the model").toBe(false);
    } finally {
      await api.close();
    }
  });
});
