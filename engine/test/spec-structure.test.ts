import { describe, expect, it } from "vitest";
import { readinessChecks } from "../src/interview/readiness";
import { SPEC_SECTIONS, structureProblems, structureText } from "../src/interview/structure";

/** A spec built from the JSON structure itself, so a template change can't leave this test behind. */
function templateSpec(override: (heading: string) => string[] = () => []): string[] {
  const out = ["# Feature: Export", "", "- **Spec version:** 1", ""];
  for (const s of SPEC_SECTIONS) {
    const custom = override(s.heading);
    if (custom.length) out.push(...custom);
    else {
      out.push(s.heading, "Text.");
      if (s.table) out.push(`| ${s.table.join(" | ")} |`, `|${s.table.map(() => "---").join("|")}|`);
    }
    out.push("");
  }
  return out;
}

describe("F-016 FR-17, AC-19: the spec's structure is checked against the JSON definition", () => {
  it("passes the template's own headings and header rows, extra sections after 12 and level-3 headings", () => {
    const spec = templateSpec((h) => (h.startsWith("## 6.") ? [h, "### Abuse cases", "Text."] : []));
    expect(structureProblems([...spec, "## Sources", "| a |", "## 13. Open questions"].join("\n"))).toEqual([]);
  });

  it("fails the trial's layout: security table under '## 6. Security and privacy' / '### Security requirements'", () => {
    const spec = templateSpec((h) => {
      if (h.startsWith("## 6.")) return ["## 6. Security and privacy", "### Security requirements", "| Id | Requirement | Source | Status |", "|---|---|---|---|"];
      if (h.startsWith("## 9.")) return ["Moved."];
      return [];
    }).join("\n");
    const problems = structureProblems(spec);
    expect(problems.join("\n")).toContain('"## 6. Edge cases" is missing');
    expect(problems.join("\n")).toContain('"## 9. Security considerations" is missing');
    expect(problems.some((p) => /^line \d+: a level-2 heading the template doesn't have/.test(p))).toBe(true);
    expect(problems.join("\n")).not.toContain("Security and privacy");
  });

  it("names a wrong header row, a repeated heading and an out-of-order heading", () => {
    const spec = templateSpec((h) => (h.startsWith("## 3.") ? [h, "| Id | Requirement | Notes |", "|---|---|---|"] : [])).join("\n");
    expect(structureProblems(spec)).toEqual([expect.stringMatching(/first table under "## 3\. Functional requirements" must have the header row \| Id \| Requirement \|$/)]);
    const lines = templateSpec();
    const twice = [...lines, "## 2. Expected behavior"].join("\n");
    expect(structureProblems(twice).join("\n")).toMatch(/appears more than once/);
    const i5 = lines.indexOf("## 5. Constraints");
    const i4 = lines.indexOf("## 4. Acceptance criteria");
    const swapped = [...lines.slice(0, i4), ...lines.slice(i5, i5 + 3), ...lines.slice(i4, i5), ...lines.slice(i5 + 3)].join("\n");
    expect(structureProblems(swapped).join("\n")).toMatch(/out of order/);
  });

  it("is a readiness check and the analyst's instructions state the structure", () => {
    const state = { list: () => [], replies: new Map(), items: new Map(), document: undefined } as never;
    const bad = readinessChecks({ spec: "# Feature\n- **Spec version:** 1\n## Security requirements\n", specVersion: 1, state, chainIntact: true });
    expect(bad.find((c) => c.name === "spec_structure")?.passed).toBe(false);
    const good = readinessChecks({ spec: templateSpec().join("\n"), specVersion: 1, state, chainIntact: true });
    expect(good.find((c) => c.name === "spec_structure")).toMatchObject({ passed: true });
    expect(structureText()).toContain("## 9. Security considerations, whose first table's header row is | Id | Requirement | Source (analyst / Security and Testability Review) | Status |");
  });
});
