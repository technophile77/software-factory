/**
 * `factory-engine mcp` (ADR 0025, F-005 FR-1, FR-15 to FR-19): a stdio MCP
 * server that Claude Code starts from the plugin's `.mcp.json`. It serves the
 * spec interview's tools and forwards each call to the running engine over
 * the Engine control channel. It starts without contacting the engine
 * (FR-17), so a stopped engine never delays Claude Code.
 *
 * Only the SDK's stdio server is imported (H-0174 condition 2), and the
 * process serves one transport with one server instance (condition 3).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OsApi } from "../os/ffi";
import { MAX_APPROVAL_WAIT_S, MAX_WAIT_S, REPLY_KINDS, ITEM_STATUSES, TOOLS_VERSION } from "./limits";
import { Interview, type Operation } from "./operations";

const SKILL = "Part of the /software-factory:spec-interview skill; call it only as that skill's steps say, "
  + "with the owner's own words or pick. Returns JSON: show the owner its `display` exactly as written.";

const feature = z.string().describe("Feature id, such as F-012.");
const waitS = z.number().int().min(0).max(MAX_WAIT_S).optional()
  .describe("Seconds the engine may wait for the analyst's research before answering; use 60.");

/** Every tool's name, description, inputs and read-only flag (SR-20: none is marked safe to repeat). */
export const TOOLS: Record<Operation, { description: string; input: Record<string, z.ZodType>; readOnly: boolean }> = {
  status: {
    description: "Checks the factory engine is reachable and reports the tool-set version, the advisor and each feature's stage.",
    input: {}, readOnly: true,
  },
  start: {
    description: "Sends the owner's new feature request, as written, optionally with a document the owner named (this tool reads it; never read it yourself).",
    input: {
      request: z.string().describe("The owner's request text, exactly as written."),
      // Loose too: an extra key inside `document` must be refused, not silently dropped.
      document: z.looseObject({
        path: z.string().describe("The file path exactly as the owner typed it."),
        provenance: z.enum(["owner", "reference"]).describe("From the owner's pick only."),
      }).optional(),
    },
    readOnly: false,
  },
  list: { description: "Lists the features with an interview waiting.", input: {}, readOnly: true },
  open: {
    description: "Opens a feature's interview session in this chat. May return a GitHub approval to show the owner.",
    input: { feature, takeover: z.boolean().optional().describe("Only after the owner said yes to ending the other session.") },
    readOnly: false,
  },
  approval: {
    description: "Waits for the owner's GitHub approval of the session opened for the feature.",
    input: { feature, wait_s: z.number().int().min(0).max(MAX_APPROVAL_WAIT_S).optional().describe("Use 120.") },
    readOnly: false,
  },
  next: { description: "Gets the feature's next interview item: deferred ones first, then new ones.", input: { feature, wait_s: waitS }, readOnly: false },
  reply: {
    description: "Sends the owner's reply to the item they were shown, with its revision and status copied from the last result.",
    input: {
      feature,
      item: z.string(),
      revision: z.number().int().min(0),
      status: z.enum(ITEM_STATUSES),
      kind: z.enum(REPLY_KINDS),
      text: z.string().describe("The owner's own words, or the exact text of the option they picked."),
      reply_id: z.string().optional().describe("Only when retrying a failed reply, from that failure's result."),
      wait_s: waitS,
    },
    readOnly: false,
  },
  state: { description: "Reports an item's status and revision, to check whether a lost reply was recorded.", input: { feature, item: z.string() }, readOnly: true },
  close: { description: "Closes the feature's interview session so the feature is free again.", input: { feature }, readOnly: false },
};

export function buildServer(interview: Interview): McpServer {
  const server = new McpServer({ name: "software-factory-interview", version: String(TOOLS_VERSION) });
  for (const [op, t] of Object.entries(TOOLS) as Array<[Operation, (typeof TOOLS)[Operation]]>) {
    server.registerTool(`interview_${op}`, {
      description: `${t.description} ${SKILL}`,
      // Loose, so an unknown field reaches the MCP mode's own check and is refused with its reason.
      inputSchema: z.looseObject(t.input),
      annotations: t.readOnly ? { readOnlyHint: true } : { readOnlyHint: false },
    }, async (args: Record<string, unknown>) => {
      const out = await interview.run(op, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], isError: out.ok !== true };
    });
  }
  return server;
}

/** Runs until Claude Code closes stdin. Nothing but MCP messages may go to stdout. */
export async function serveMcp(os: OsApi, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const interview = new Interview({ os, projectDir: env.CLAUDE_PROJECT_DIR || undefined });
  const server = buildServer(interview);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
  });
}
