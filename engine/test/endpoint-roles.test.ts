import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  RoleAssignmentError, isReadOnlyRole, manifestAssignments, parseRoleAssignments, planAdvisory, planRole,
  type PlanInput, type RoleAssignment,
} from "../src/config/endpoint-roles";
import { validateManifest } from "../src/config/manifest";
import { manifestYaml } from "./helpers";

const READ_ONLY = { write: { allow: [".factory/runs/**"], deny: [] }, network: [] };
const WRITES = { write: { allow: ["docs/**"], deny: [] }, network: [] };
const ONLINE = { write: { allow: [".factory/runs/**"], deny: [] }, network: ["example.com"] };

describe("parseRoleAssignments (provisional role assignment, F-013 SR-9, F-002 A-3)", () => {
  it("reads model, fallback and advisory, and ignores keys that belong to other features", () => {
    const m = parseRoleAssignments({
      "log-reader": { model: "lan/qwen3.8-27b", fallback: "claude-haiku-4-5", rung: 2 },
      "security-reviewer": { advisory: "lan/qwen3.8-27b" },
      orchestrator: { rung: 1 },
    });
    expect([...m.keys()]).toEqual(["log-reader", "security-reviewer"]);
    expect(m.get("log-reader")).toEqual({ role: "log-reader", model: { endpoint: "lan", model: "qwen3.8-27b" }, fallback: "claude-haiku-4-5" });
    expect(m.get("security-reviewer")).toEqual({ role: "security-reviewer", advisory: { endpoint: "lan", model: "qwen3.8-27b" } });
  });

  it("means no assignments when settings.agents is absent", () => {
    expect(parseRoleAssignments(undefined).size).toBe(0);
    expect(manifestAssignments({ settings: {} }).size).toBe(0);
    expect(manifestAssignments("not a manifest").size).toBe(0);
  });

  it.each([
    ["an endpoint model without a fallback", { a: { model: "lan/m" } }, /fallback .* is required/],
    ["a fallback without a model", { a: { fallback: "claude-haiku-4-5" } }, /only goes with/],
    ["a fallback that is itself an endpoint rung", { a: { model: "lan/m", fallback: "lan/other" } }, /Claude model id/],
    ["a model that names no endpoint", { a: { model: "claude-haiku-4-5", fallback: "claude-haiku-4-5" } }, /<endpoint>\/<model>/],
    ["an advisory that names no endpoint", { "security-reviewer": { advisory: "claude-haiku-4-5" } }, /<endpoint>\/<model>/],
    ["an endpoint model on a gate role (F-002 A-3)", { "security-reviewer": { model: "lan/m", fallback: "claude-sonnet-5-5" } }, /stays on its Claude model/],
    ["an endpoint model on the validation judge", { "validation-judge": { model: "lan/m", fallback: "claude-sonnet-5-5" } }, /stays on its Claude model/],
    ["an advisory on a role that isn't a gate", { "log-reader": { advisory: "lan/m" } }, /only the gate roles/],
    ["a role that is not a mapping", { a: "lan/m" }, /must be a mapping/],
    ["settings.agents that is not a mapping", ["a"], /must map each role/],
  ])("refuses %s", (_what, doc, message) => {
    expect(() => parseRoleAssignments(doc)).toThrow(RoleAssignmentError);
    expect(() => parseRoleAssignments(doc)).toThrow(message);
  });
});

describe("isReadOnlyRole (SR-9)", () => {
  it("allows only writes under .factory/ and no network host", () => {
    expect(isReadOnlyRole(READ_ONLY)).toBe(true);
    expect(isReadOnlyRole({ write: { allow: [], deny: [] }, network: [] })).toBe(true);
    expect(isReadOnlyRole(WRITES)).toBe(false);
    expect(isReadOnlyRole(ONLINE)).toBe(false);
    expect(isReadOnlyRole({ write: { allow: [".factory/x", "src/**"], deny: [] }, network: [] })).toBe(false);
  });
});

const assignment: RoleAssignment = { role: "log-reader", model: { endpoint: "lan", model: "qwen3" }, fallback: "claude-haiku-4-5" };
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  role: "log-reader", assignment, claudeDefault: "claude-sonnet-5-5", allowed: ["lan"], unavailable: () => null, ...over,
});

describe("planRole (AC-13, FR-7)", () => {
  it("uses the master default for a role with no assignment", () => {
    expect(planRole(input({ assignment: undefined }), WRITES)).toEqual({ kind: "claude", model: "claude-sonnet-5-5" });
  });

  it("puts a read-only role on its endpoint rung when the project lists the endpoint and the PC has it", () => {
    expect(planRole(input(), READ_ONLY)).toEqual({ kind: "endpoint", rung: { endpoint: "lan", model: "qwen3" }, fallback: "claude-haiku-4-5" });
  });

  it("AC-13: runs on the fallback with the reason when the manifest doesn't list the endpoint", () => {
    const p = planRole(input({ allowed: [] }), READ_ONLY);
    expect(p).toEqual({ kind: "claude", model: "claude-haiku-4-5", because: { endpoint: "lan", reason: expect.stringContaining("manifest doesn't list") } });
  });

  it("runs on the fallback with the PC's reason when the endpoint is unavailable", () => {
    const p = planRole(input({ unavailable: () => "it doesn't list the configured model" }), READ_ONLY);
    expect(p).toEqual({ kind: "claude", model: "claude-haiku-4-5", because: { endpoint: "lan", reason: "it doesn't list the configured model" } });
  });

  it("SR-9: refuses a role that writes outside .factory/ or reaches the network", () => {
    expect(() => planRole(input(), WRITES)).toThrow(/SR-9/);
    expect(() => planRole(input(), ONLINE)).toThrow(RoleAssignmentError);
  });
});

describe("planAdvisory (FR-10, FR-11)", () => {
  const adv: RoleAssignment = { role: "security-reviewer", advisory: { endpoint: "lan", model: "qwen3" } };
  const ai = (over: Partial<PlanInput> = {}) => input({ role: "security-reviewer", assignment: adv, ...over });

  it("has nothing to do without an advisory key", () => {
    expect(planAdvisory(ai({ assignment: undefined }))).toEqual({ kind: "none" });
  });
  it("runs on the rung when allowed and available", () => {
    expect(planAdvisory(ai())).toEqual({ kind: "run", rung: { endpoint: "lan", model: "qwen3" } });
  });
  it("skips, with a reason, when the project doesn't list the endpoint or the PC can't serve it", () => {
    expect(planAdvisory(ai({ allowed: [] }))).toMatchObject({ kind: "skip", because: { endpoint: "lan" } });
    expect(planAdvisory(ai({ unavailable: () => "it didn't answer in time" }))).toEqual({ kind: "skip", because: { endpoint: "lan", reason: "it didn't answer in time" } });
  });
});

describe("project manifest settings.agents (v1.5, provisional)", () => {
  const withAgents = (agents: unknown) => {
    const doc = YAML.parse(manifestYaml());
    doc.settings.agents = agents;
    return validateManifest(doc, "0".repeat(40));
  };

  it("accepts the endpoint keys beside existing ones", () => {
    const m = withAgents({ "security-reviewer": { advisory: "lan/qwen3", rung: 1 } });
    expect(manifestAssignments(m.raw).get("security-reviewer")?.advisory).toEqual({ endpoint: "lan", model: "qwen3" });
  });

  it("refuses a gate role set to an endpoint, with the manifest file named", () => {
    expect(() => withAgents({ "security-reviewer": { model: "lan/qwen3", fallback: "claude-sonnet-5-5" } })).toThrow(/factory-project\.yaml: .*stays on its Claude model/);
  });
});
