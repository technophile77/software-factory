import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { McpConfigError, mcpIdentity, mcpLiterals, parseMcpServers } from "../src/config/mcp-servers";
import { validateManifest } from "../src/config/manifest";
import { comparePin, pinnedKeys } from "../src/config/pins";
import { effectiveRole } from "../src/policy/role-policy";
import { checkConfig, manifestFile } from "../src/schemas/config";
import { mcpServerRecord } from "../src/schemas/mcp-server-record";
import { isSecretName, mcpSecretItem } from "../src/secrets";
import { manifestYaml } from "./helpers";
import { policyDoc } from "./policy-fixture";

const SHA = "a".repeat(64);
const npm = (version: unknown) => [{ name: "tracker", local: { package: { ecosystem: "npm", name: "@example/tracker-mcp", version } } }];

describe("F-025 mcp_servers (manifest v1.12, FR-1 to FR-4)", () => {
  it("reads a package, a command and a remote server", () => {
    const s = parseMcpServers([
      { name: "tracker", local: { package: { ecosystem: "npm", name: "@example/tracker-mcp", version: "1.4.2" }, args: ["--read-only"], env: { URL: "https://t.example.test", TOKEN: { secret: "token" } } } },
      { name: "tool", local: { command: ["/opt/tools/tool-mcp", "--stdio"], sha256: SHA } },
      { name: "docs", remote: { url: "https://mcp.example.test/mcp", headers: { Authorization: { secret: "auth" } } } },
      { name: "py", local: { package: { ecosystem: "pypi", name: "docs_mcp", version: "2.0.1rc1" } } },
    ]);
    expect(s.map(mcpIdentity)).toEqual(["package:npm:@example/tracker-mcp@1.4.2", `command:${SHA}`, "remote:https://mcp.example.test/mcp", "package:pypi:docs_mcp@2.0.1rc1"]);
    expect(mcpLiterals(s)).toEqual([{ where: "mcp_servers[tracker].env.URL", value: "https://t.example.test" }]);
    expect(parseMcpServers(undefined)).toEqual([]);
  });

  it("AC-2: refuses a version range, tag or latest, and a command without its hash or with a relative path", () => {
    for (const v of ["^1.2.0", "~1.2.0", "1.x", "latest", "next", ">=1", "1.2", ""]) expect(() => parseMcpServers(npm(v)), v).toThrow(/one exact version/);
    expect(() => parseMcpServers([{ name: "t", local: { command: ["/opt/t"] } }])).toThrow(/sha256/);
    expect(() => parseMcpServers([{ name: "t", local: { command: ["/opt/t"], sha256: "ABC" } }])).toThrow(/sha256/);
    expect(() => parseMcpServers([{ name: "t", local: { command: ["tool-mcp"], sha256: SHA } }])).toThrow(/absolute path/);
    expect(parseMcpServers([{ name: "t", local: { command: ["C:\\tools\\t.exe"], sha256: SHA } }])[0]!.kind).toBe("command");
  });

  it("AC-3: refuses an http URL or one with user info", () => {
    expect(() => parseMcpServers([{ name: "d", remote: { url: "http://mcp.example.test/" } }])).toThrow(/must be https/);
    expect(() => parseMcpServers([{ name: "d", remote: { url: "https://u:p@mcp.example.test/" } }])).toThrow(/user name or password/);
  });

  it("FR-1: refuses the engine's own name, a repeated name, both or neither of local and remote, and unknown keys", () => {
    const remote = { url: "https://mcp.example.test/" };
    expect(() => parseMcpServers([{ name: "factory", remote }])).toThrow(/engine's own server/);
    expect(() => parseMcpServers([{ name: "d", remote }, { name: "d", remote }])).toThrow(/twice/);
    expect(() => parseMcpServers([{ name: "d" }])).toThrow(/exactly one of local or remote/);
    expect(() => parseMcpServers([{ name: "d", remote, local: {} }])).toThrow(/exactly one of local or remote/);
    expect(() => parseMcpServers([{ name: "d", remote: { ...remote, extra: 1 } }])).toThrow(McpConfigError);
    expect(() => parseMcpServers([{ name: "D", remote }])).toThrow(/name must be/);
  });

  it("FR-4, FR-8: a secret reference names a key only, and the engine's own variables can't be set", () => {
    expect(() => parseMcpServers([{ name: "d", remote: { url: "https://m.example.test/", headers: { X: { secret: "../other" } } } }])).toThrow(/secret must be a key/);
    expect(() => parseMcpServers([{ name: "t", local: { command: ["/opt/t"], sha256: SHA, env: { PATH: "/tmp" } } }])).toThrow(/set by the engine/);
  });

  it("the manifest carries the servers, and its outline check accepts them", () => {
    const extra = YAML.stringify({ mcp_servers: npm("1.4.2") });
    const doc = YAML.parse(manifestYaml({ extra })) as Record<string, unknown>;
    expect(validateManifest(doc, "c".repeat(40)).mcpServers).toHaveLength(1);
    expect(() => checkConfig("factory-project.yaml", doc, manifestFile)).not.toThrow();
    const bad = YAML.parse(manifestYaml({ extra: YAML.stringify({ mcp_servers: npm("latest") }) }));
    expect(() => validateManifest(bad, "c".repeat(40))).toThrow(/mcp_servers\[0\]\.local\.package\.version/);
  });
});

describe("F-025 secrets (FR-4, SR-1)", () => {
  it("names one key of one server of one project, and nothing else", () => {
    expect(mcpSecretItem("acme", "tracker", "token")).toBe("mcp-secret/acme/tracker/token");
    expect(isSecretName("mcp-secret/acme/tracker/token")).toBe(true);
    for (const n of ["mcp-secret/acme/tracker", "mcp-secret/acme/../token", "mcp-secret/acme/Tracker/token", "mcp-secret/acme/tracker/token/x"]) expect(isSecretName(n), n).toBe(false);
    expect(() => mcpSecretItem("acme", "tracker", "A B")).toThrow();
  });
});

describe("F-025 role policy v2.13 (FR-5, AC-6)", () => {
  const withMcp = (allow: string[], over: string[] | undefined = undefined) => {
    const doc = policyDoc({}, [{ name: "app", url: "https://github.com/example-org/app", ...(over ? { policy: { roles: { "software-developer": { mcp: { allow: over } } } } } : {}) }]);
    const roles = (doc.policy as { roles: Record<string, Record<string, unknown>> }).roles;
    roles["software-developer"] = { ...roles["software-developer"], mcp: { allow } };
    return { ...doc, mcp_servers: [{ name: "db" }, { name: "docs" }] };
  };

  it("a role lists whole servers or single tools; nothing by default", () => {
    expect(effectiveRole(withMcp(["db/query", "docs"]), "software-developer").mcp).toEqual(["db/query", "docs"]);
    expect(effectiveRole(withMcp([]), "software-developer").mcp).toBeUndefined();
    expect(effectiveRole(withMcp(["docs"]), "orchestrator").mcp).toBeUndefined();
  });

  it("refuses a server the manifest doesn't declare, and a malformed entry", () => {
    expect(() => effectiveRole(withMcp(["nope"]), "software-developer")).toThrow(/not in mcp_servers/);
    expect(() => effectiveRole(withMcp(["db/query/x"]), "software-developer")).toThrow(/<server>\/<tool>/);
  });

  it("AC-6: a repo override may narrow, never add", () => {
    expect(effectiveRole(withMcp(["db"], ["db/query"]), "software-developer", "app").mcp).toEqual(["db/query"]);
    expect(effectiveRole(withMcp(["db"], []), "software-developer", "app").mcp).toBeUndefined();
    expect(() => effectiveRole(withMcp(["db/query"], ["db"]), "software-developer", "app")).toThrow(/may not add MCP/);
    expect(() => effectiveRole(withMcp(["db"], ["docs"]), "software-developer", "app")).toThrow(/may not add MCP/);
  });
});

describe("F-025 pinning (FR-13, AC-11)", () => {
  const manifest = (extra: string) => validateManifest(YAML.parse(manifestYaml({ extra })), "c".repeat(40));
  it("an added server or a widened allow list is a changed pinned key; an older pin matches a manifest with neither", () => {
    const plain = manifest("");
    const pin = { ...pinnedKeys(plain), pinned_at: "x", commit: plain.commit };
    const { mcp: _drop, ...oldPin } = pin;
    expect(comparePin(oldPin, plain)).toEqual({ status: "match" });
    const added = manifest(YAML.stringify({ mcp_servers: npm("1.4.2") }));
    expect(comparePin(pin, added)).toEqual({ status: "changed", keys: ["mcp_servers"] });
    const pinAdded = { ...pinnedKeys(added), pinned_at: "x", commit: added.commit };
    const widened = { ...added, raw: { ...(added.raw as object), policy: { roles: { "software-developer": { mcp: { allow: ["tracker"] } } } } } };
    expect(comparePin(pinAdded, widened)).toEqual({ status: "changed", keys: ["mcp_servers"] });
  });
});

describe("F-025 MCP server record v1.0 (FR-6)", () => {
  const base = {
    schema: "mcp-server-record/1.0", server: "tracker", kind: "package", ecosystem: "npm", name: "@example/tracker-mcp", version: "1.4.2", lockfile_sha256: SHA,
    install_scripts: false, cve_scan: { tool: "osv-scanner", ran_at: "2026-11-21T23:30:00Z", critical: 0, high: 0, medium: 0, low: 0 },
    tools: [{ name: "search", class: "reads", description_sha256: SHA }],
    data: { receives: "search terms", sends_to: ["tracker.example.test"], leaves_pc: true },
    review: ".factory/runs/x/security-reviewer.json",
    approved: { item: "S-0001", at: "2026-11-21T23:40:00Z", local_risk_accepted: true },
  };
  it("accepts a complete record and refuses an unknown key, a missing pin, or a local server without the owner's risk acceptance", () => {
    expect(mcpServerRecord.safeParse(base).success).toBe(true);
    expect(mcpServerRecord.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(mcpServerRecord.safeParse({ ...base, lockfile_sha256: undefined }).success).toBe(false);
    expect(mcpServerRecord.safeParse({ ...base, approved: { ...base.approved, local_risk_accepted: false } }).success).toBe(false);
    expect(mcpServerRecord.safeParse({ ...base, tools: [base.tools[0], base.tools[0]] }).success).toBe(false);
  });
});
