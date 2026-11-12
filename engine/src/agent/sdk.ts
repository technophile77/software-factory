import type { Readable, Writable } from "node:stream";

/**
 * The part of the Claude Agent SDK 0.3.311 surface the engine uses, written
 * out here so session code and its tests don't depend on how the package is
 * installed. The shapes follow the SDK's own `sdk.d.ts`; the binding that
 * passes the real `query` and `createSdkMcpServer` lives in one place
 * (agent/sdk-binding.ts) once the package is added.
 */

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}

export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type CanUseTool = (toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<PermissionResult>;

/** Claude Code's PreToolUse hook callback, the part of the SDK's HookCallback the engine uses. */
export type PreToolUseHook = (
  input: { hook_event_name: string; tool_name?: unknown; tool_input?: unknown },
  toolUseId: string | undefined,
  o: { signal: AbortSignal },
) => Promise<{ hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } }>;

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** An in-process MCP tool as the engine defines it, before it's handed to the SDK. */
export interface FactoryTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments, for the model; the handler validates them itself (SR-3). */
  inputSchema: Record<string, unknown>;
  handler(args: unknown): Promise<CallToolResult>;
}

/** The fixed session options (SR-10). Only these keys are ever set. */
export interface SessionOptions {
  cwd: string;
  settingSources: [];
  strictMcpConfig: true;
  mcpServers: Record<"factory", unknown>;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: "default";
  canUseTool: CanUseTool;
  /** Only the engine's own gate; settingSources: [] keeps every other hook out. */
  hooks: { PreToolUse: [{ hooks: [PreToolUseHook] }] };
  systemPrompt: string;
  plugins: Array<{ type: "local"; path: string }>;
  maxTurns: number;
  maxBudgetUsd?: number;
  model?: string;
  resume?: string;
  env: Record<string, string>;
  abortController: AbortController;
  spawnClaudeCodeProcess(o: SpawnOptions): SpawnedProcess;
  stderr?(data: string): void;
}

/** The SDK messages the engine reads; anything else is passed over. */
export type SdkMessage =
  | { type: "system"; subtype: "init"; session_id: string; tools?: string[]; mcp_servers?: Array<{ name: string; status: string }>; model?: string }
  | { type: "assistant"; session_id: string; message: { content?: Array<{ type: string; name?: string; input?: unknown }>; usage?: { output_tokens?: number } } }
  | { type: "result"; subtype: string; session_id: string; num_turns?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; result?: string; is_error?: boolean; errors?: string[] }
  | { type: string; session_id?: string; [k: string]: unknown };

export interface UserTurn {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export interface AgentSdk {
  query(p: { prompt: AsyncIterable<UserTurn>; options: SessionOptions }): AsyncIterable<SdkMessage>;
  createFactoryServer(tools: FactoryTool[]): unknown;
}
