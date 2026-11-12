import type * as Sdk from "@anthropic-ai/claude-agent-sdk";
import * as z from "zod";
import type { AgentSdk, FactoryTool, SessionOptions } from "./sdk";

/**
 * A FactoryTool's JSON Schema as the zod shape the SDK's `tool()` wants. The
 * handler still validates every argument itself (SR-3); this shape is what
 * the model sees, and an extra check in front.
 */
export function zodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(props)) {
    const t = z.fromJSONSchema(v as never) as z.ZodType;
    shape[k] = required.has(k) ? t : t.optional();
  }
  return shape;
}

/**
 * The real Claude Agent SDK 0.3.311 behind the engine's AgentSdk seam. The
 * package is ESM and finds its own files from its location, so it stays
 * outside the bundle and is loaded at run time. Every session passes
 * `spawnClaudeCodeProcess` (SR-10), so the SDK's bundled host binary is never
 * started.
 */
export async function loadAgentSdk(): Promise<AgentSdk> {
  const sdk: typeof Sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    createFactoryServer: (tools: FactoryTool[]) =>
      sdk.createSdkMcpServer({
        name: "factory",
        version: "1.0.0",
        tools: tools.map((t) => sdk.tool(t.name, t.description, zodShape(t.inputSchema), (args) => t.handler(args) as never)),
      }),
    query: ({ prompt, options }) => {
      if (typeof options.spawnClaudeCodeProcess !== "function") throw new Error("refused: a session without the container spawn");
      return sdk.query({ prompt: prompt as never, options: options as unknown as Sdk.Options }) as never;
    },
  };
}

export type { SessionOptions };
