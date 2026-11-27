import { z } from "zod";

/**
 * MCP server record v1.1 (F-025 FR-6, FR-18, SR-5 to SR-9, ADR 0036, H-0278):
 * `.factory/mcp/<server>.json` on the project's factory/state. Facts from
 * the approval: what the server is pinned to, its CVE scan, each tool's
 * class and description hash, and the owner's approval. A server whose
 * manifest entry doesn't match its record doesn't run. v1.1 holds only the
 * tools the owner approved, each with its risk; a v1.0 record still reads as
 * approving every tool it lists.
 */

const text = (max: number) => z.string().max(max);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const host = z.string().regex(/^[a-z0-9.-]{1,253}$/);

export const MCP_SERVER_RECORD_SCHEMA = "mcp-server-record/1.1";
const OLD_RECORD_SCHEMA = "mcp-server-record/1.0";

/** F-025 FR-16: the security-standards severity scale, plus `none`. */
export const MCP_RISKS = ["none", "low", "medium", "high", "critical"] as const;
export type McpRisk = (typeof MCP_RISKS)[number];
/** FR-17: option C approves only the tools below this. */
export const isHighRisk = (r: McpRisk | undefined): boolean => r === "high" || r === "critical";

export const mcpServerRecord = z.strictObject({
  schema: z.enum([MCP_SERVER_RECORD_SCHEMA, OLD_RECORD_SCHEMA]),
  server: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  kind: z.enum(["package", "command", "remote"]),
  ecosystem: z.enum(["npm", "pypi"]).optional(),
  name: text(214).optional(),
  version: text(100).optional(),
  /** SR-5: the lockfile the package was installed from at approval; every start installs from it. */
  lockfile_sha256: sha256.optional(),
  /** SR-13: a command server's executable, as copied into the server's folder. */
  sha256: sha256.optional(),
  url: text(500).optional(),
  install_scripts: z.boolean(),
  cve_scan: z.strictObject({ tool: text(100), ran_at: text(40), critical: count, high: count, medium: count, low: count }).optional(),
  tools: z.array(z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    class: z.enum(["reads", "acts"]),
    /** SR-7: name, description and input schema, so a changed tool is left out until it is reviewed again. */
    description_sha256: sha256,
    risk: z.enum(MCP_RISKS).optional(),
  })).max(500),
  data: z.strictObject({ receives: text(2000), sends_to: z.array(host).max(50), leaves_pc: z.boolean() }),
  review: text(300),
  /** FR-17: `A` approved every allowed tool, `C` only those rated medium or lower. */
  approved: z.strictObject({ item: text(100), at: text(40), local_risk_accepted: z.boolean(), choice: z.enum(["A", "C"]).optional() }),
}).superRefine((r, ctx) => {
  const need = (ok: boolean, message: string) => {
    if (!ok) ctx.addIssue({ code: "custom", message });
  };
  if (r.kind === "package") need(!!r.ecosystem && !!r.name && !!r.version && !!r.lockfile_sha256 && r.sha256 === undefined && r.url === undefined && !!r.cve_scan, "a package record needs ecosystem, name, version, lockfile_sha256 and cve_scan, and no sha256 or url");
  if (r.kind === "command") need(!!r.sha256 && r.ecosystem === undefined && r.url === undefined, "a command record needs sha256, and no package or url");
  if (r.kind === "remote") need(!!r.url && r.ecosystem === undefined && r.sha256 === undefined, "a remote record needs url, and no package or sha256");
  // SR-8: a local server runs as the owner, which the owner accepts on each one's approval.
  if (r.kind !== "remote") need(r.approved.local_risk_accepted, "a local server's approval must record that the owner accepted its risk");
  need(new Set(r.tools.map((t) => t.name)).size === r.tools.length, "tools lists a name twice");
  if (r.schema === MCP_SERVER_RECORD_SCHEMA) need(r.tools.every((t) => t.risk !== undefined) && r.approved.choice !== undefined, "a v1.1 record gives each tool's risk and the owner's choice");
  else need(r.tools.every((t) => t.risk === undefined) && r.approved.choice === undefined, "a v1.0 record has no risk or choice");
});

export type McpServerRecord = z.infer<typeof mcpServerRecord>;
