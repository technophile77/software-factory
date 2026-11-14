import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SCHEMA_DIR, writeSchemas } from "../scripts/write-schemas";
import { SCHEMAS, jsonSchemaText } from "../src/schemas";
import { modelReport } from "../src/schemas/agent-report";
import { prRecord } from "../src/schemas/pr-record";
import { SchemaError, parseJsonFile } from "../src/schemas/json-file";
import { agentReport } from "../src/state/runs";
import YAML from "yaml";
import type { ZodType } from "zod";
import { endpointsFile, limitsFile, manifestFile, modelsFile } from "../src/schemas/config";
import { manifestYaml, removeTmpdirs, tmpdir } from "./helpers";

// F-020 FR-1, FR-2, FR-3, FR-5, FR-8, SR-6, SR-7.

afterAll(removeTmpdirs);

const COMMIT = "a".repeat(40);
const testReport = (body: Record<string, unknown>) => ({
  schema: "agent-report/1.0", role: "test-engineer", feature: "F-012", stage: "build_and_test_prep", commit: COMMIT, outcome: "complete", summary: "Done.", body,
});
const TEST_BODY = {
  tests_run: 3, passed: 3, failed: 0, skipped: 0, criteria_map: { "AC-1": ["t1"] }, failures: [], not_run: [],
  tool_choices: [{ test_type: "acceptance", tool: "vitest", reason: "already in the engine", approval_ref: null }],
};

describe("F-020 schema files", () => {
  it("FR-2 (AC-2): every committed schema file matches what the script writes, and there are no others", () => {
    const committed = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort();
    expect(committed).toEqual(Object.keys(SCHEMAS).map((n) => `${n}.schema.json`).sort());
    for (const n of Object.keys(SCHEMAS)) {
      expect(fs.readFileSync(path.join(SCHEMA_DIR, `${n}.schema.json`), "utf8"), `docs/schemas/${n}.schema.json is stale: run npm run write-schemas`).toBe(jsonSchemaText(n));
    }
  });

  it("FR-2: the script writes each file and removes one the list no longer has", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "gone-1.schema.json"), "{}");
    writeSchemas(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(Object.keys(SCHEMAS).map((n) => `${n}.schema.json`).sort());
  });

  it("SR-6: every object in every schema refuses unknown keys", () => {
    const loose: string[] = [];
    const walk = (s: unknown, where: string) => {
      if (!s || typeof s !== "object") return;
      const o = s as Record<string, unknown>;
      if (o.type === "object" && o.properties && o.additionalProperties !== false && where !== "agent-report-1.body" && !where.includes(".effect") && !where.includes("proposed_items") && !where.includes("advisory") && !where.includes("endpoint_rates")) loose.push(where);
      for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
    };
    for (const n of Object.keys(SCHEMAS)) walk(JSON.parse(jsonSchemaText(n)), n);
    expect(loose).toEqual([]);
  });
});

describe("F-020 agent reports", () => {
  it("SR-7: a model's report that sets an engine-filled field is refused", () => {
    for (const extra of [{ model: "x" }, { usage: {} }, { rung: 1 }, { fallback: {} }, { items_filed: [] }, { artifacts: [] }]) {
      const r = modelReport("test-engineer").safeParse({ ...testReport(TEST_BODY), ...extra });
      expect(r.success).toBe(false);
    }
    expect(modelReport("test-engineer").safeParse(testReport(TEST_BODY)).success).toBe(true);
  });

  it("FR-8 (AC-9): a test engineer report without tool_choices is refused; a developer report needs docs_updated", () => {
    const { tool_choices: _drop, ...noTools } = TEST_BODY;
    expect(modelReport("test-engineer").safeParse(testReport(noTools)).success).toBe(false);
    const dev = { ...testReport({ files_changed: ["a.ts"], spec_deviations: [], not_done: [] }), role: "software-developer" };
    expect(modelReport("software-developer").safeParse(dev).success).toBe(false);
    expect(modelReport("software-developer").safeParse({ ...dev, body: { ...dev.body, docs_updated: ["README.md"] } }).success).toBe(true);
  });

  it("FR-3: the engine never writes a stored report that fails its schema", () => {
    const base = { feature: "F-012", stage: "security_gate_1", role: "security-reviewer", n: 1, commit: COMMIT, outcome: "complete" as const, summary: "s", body: {}, facts: {} };
    expect(JSON.parse(String(agentReport(base).content))).toMatchObject({ schema: "agent-report/1.0", items_filed: [], artifacts: [] });
    expect(() => agentReport({ ...base, summary: "x".repeat(5000) })).toThrow(SchemaError);
  });
});

describe("F-020 PR records (FR-5, AC-15)", () => {
  const rec = { schema: "pr-record/1.0", repo: "o/app", number: 4, feature: "F-012", history: [{ at: "2026-11-14T00:00:00Z", action: "closed_on_github" }] };
  it("a valid record parses; one missing feature is refused naming the field", () => {
    expect(parseJsonFile("prs/o/app/4.json", JSON.stringify(rec), prRecord).number).toBe(4);
    const { feature: _f, ...noFeature } = rec;
    expect(() => parseJsonFile("prs/o/app/4.json", JSON.stringify(noFeature), prRecord)).toThrow("prs/o/app/4.json: feature is invalid (invalid_type)");
  });
});

describe("F-020 hand-edited YAML schemas (FR-11, FR-12, AC-12)", () => {
  const repoRoot = path.join(__dirname, "..", "..");
  const read = (p: string) => YAML.parse(fs.readFileSync(path.join(repoRoot, p), "utf8"));
  const contractEndpoints = () => {
    const doc = fs.readFileSync(path.join(repoRoot, "docs", "interface-contracts.md"), "utf8");
    const at = doc.indexOf("## Model endpoints file");
    const block = /```yaml\n([\s\S]*?)```/.exec(doc.slice(at))![1]!;
    return YAML.parse(block.replace(/<[^>]+>/g, "x"));
  };
  const examples: Array<[string, unknown, ZodType]> = [
    ["engine/config/limits.yaml", read("engine/config/limits.yaml"), limitsFile],
    ["engine/config/models.yaml", read("engine/config/models.yaml"), modelsFile],
    ["onboarding template factory-project.yaml", read("plugins/software-factory/skills/onboard-repo/templates/factory-project.yaml"), manifestFile],
    ["test manifest", YAML.parse(manifestYaml()), manifestFile],
    ["contract endpoints example", contractEndpoints(), endpointsFile],
  ];

  for (const [name, doc, schema] of examples) {
    it(`${name} validates, and a copy with an unknown top-level key fails`, () => {
      const ok = schema.safeParse(doc);
      expect(ok.success, ok.success ? "" : JSON.stringify(ok.error.issues[0])).toBe(true);
      expect(schema.safeParse({ ...(doc as object), surprise: 1 }).success).toBe(false);
    });
  }
});
