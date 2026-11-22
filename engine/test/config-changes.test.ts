// F-015 FR-28: configuration changes a spec needs are listed in section 7, block the gate until applied, and are tested against the manifest.
import { describe, expect, it } from "vitest";
import { configChanges, configChangesCheck, failedConfigChecks } from "../src/readiness/checks";

const spec = (rows: string) => `# Feature

## 6. Edge cases
None.

## 7. Dependencies
Nothing else.

### Configuration changes needed before implementation
| Id | Change | Check | Status |
|---|---|---|---|
${rows}

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
`;

const dev = { allow: ["*.py", "deploy.sh"], deny: ["tests/**", "supervisor/**"] };

describe("configuration changes a spec needs (F-015 FR-28)", () => {
  it("reads the rows, with and without a check", () => {
    const rows = configChanges(spec("| C-1 | Allow deploy.sh | `software-developer may write deploy.sh` | Applied |\n| C-2 | Add a CI job | — | Pending |"));
    expect(rows).toEqual([
      { id: "C-1", change: "Allow deploy.sh", check: { role: "software-developer", may: true, path: "deploy.sh" }, status: "Applied" },
      { id: "C-2", change: "Add a CI job", check: null, status: "Pending" },
    ]);
    expect(configChanges("## 7. Dependencies\nNone.\n")).toEqual([]);
  });

  it("AC-55, AC-57: the gate fails on a row not applied and on a check it can't read, naming ids only", () => {
    expect(configChangesCheck(spec("| C-1 | Allow deploy.sh | `software-developer may write deploy.sh` | Applied |")).passed).toBe(true);
    const pending = configChangesCheck(spec("| C-1 | Allow deploy.sh | `software-developer may write deploy.sh` | Pending |"));
    expect(pending).toMatchObject({ name: "config_changes_applied", passed: false, evidence: "C-1 is not Applied." });
    const bad = configChangesCheck(spec("| C-1 | Allow deploy.sh | the developer can edit it | Applied |"));
    expect(bad.passed).toBe(false);
    expect(bad.evidence).toContain("C-1's Check isn't");
    expect(configChangesCheck("## 7. Dependencies\nNone.\n").passed).toBe(true);
  });

  it("AC-56: a row marked Applied whose check the manifest doesn't meet fails at build start", () => {
    const s = spec([
      "| C-1 | Allow deploy.sh | `software-developer may write deploy.sh` | Applied |",
      "| C-2 | Allow supervisor | `software-developer may write supervisor/mesbot.conf` | Applied |",
      "| C-3 | Keep tests out | `software-developer may not write tests/test_x.py` | Applied |",
      "| C-4 | Unknown role | `ghost may write x.py` | Applied |",
    ].join("\n"));
    const failed = failedConfigChecks(s, (role) => {
      if (role !== "software-developer") throw new Error(`no role ${role}`);
      return dev;
    });
    expect(failed).toEqual([
      { id: "C-2", why: "the manifest says software-developer may not write supervisor/mesbot.conf" },
      { id: "C-4", why: "the ghost role's policy can't be read (no role ghost)" },
    ]);
  });
});
