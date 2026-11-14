import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { LIMITS_FILE, parseLimits } from "../src/config/limits";
import { limitsFile } from "../src/schemas/config";
import { currentStage, currentType, legacyAlertKey } from "../src/legacy-names";
import { InterviewState } from "../src/interview/model";
import { SPEC_SECTIONS, structureProblems } from "../src/interview/structure";
import { citesFinding, refLength, stReviewQuestionProblem } from "../src/st-review/flow";
import type { Entry } from "../src/state/transcript";

// The F-002 trial's transcript, inbox and spec were written with the gate ids from before the rename (H-0249).
describe("H-0249: records written before the gate rename still read", () => {
  let seq = 0;
  const e = (type: string, body: Record<string, unknown> = {}): Entry => ({ seq: ++seq, at: "2026-11-13T00:00:00.000Z", type, prev: null, hash: "", ...body });

  it("maps old stage ids, entry types and alert types to the new ones", () => {
    expect(currentStage("security_gate_1")).toBe("security_testability_review");
    expect(currentStage("security_gate_2")).toBe("code_review");
    expect(currentStage("readiness_gate")).toBe("readiness_gate");
    expect(currentType("gate1_risk")).toBe("st_review_risk");
    expect(currentType("gate1cap")).toBe("streviewcap");
    expect(currentType("gate1unresolved")).toBe("streviewunresolved");
    expect(currentType("breach")).toBe("breach");
    expect(legacyAlertKey("streviewcap:F-002:3")).toBe("gate1cap:F-002:3");
    expect(legacyAlertKey("breach:F-002")).toBeNull();
  });

  it("a transcript with old ids gives the same state as one with new ids", () => {
    const old = new InterviewState();
    const findings = [{ n: 1, criterion: "S8.5", severity: "Medium", fix: "f", explanation: "x", needs_owner: false }];
    for (const x of [
      e("stage", { stage: "security_gate_1" }),
      e("gate1_run", { run: "R-1" }),
      e("gate1_report", { run: "R-1", report: 1, findings }),
      e("gate1_blocked", { reason: "cap", risk: [1] }),
      e("returned", { return: { why: "gate1_unresolved", evidence: "x" } }),
    ]) old.apply(x);
    const now = new InterviewState();
    for (const x of [
      e("stage", { stage: "security_testability_review" }),
      e("st_review_run", { run: "R-1" }),
      e("st_review_report", { run: "R-1", report: 1, findings }),
      e("st_review_blocked", { reason: "cap", risk: [1] }),
      e("returned", { return: { why: "st_review_unresolved", evidence: "x" } }),
    ]) now.apply(x);
    expect(old.stage).toBe("security_testability_review");
    expect(old.stReview.runs).toBe(1);
    expect(old.stReview.blocked).toBe("cap");
    expect(old.stReview.unresolvedSent).toBe(1);
    expect(old.returns).toEqual(now.returns);
    expect({ ...old.stReview, reportAt: null }).toEqual({ ...now.stReview, reportAt: null });
  });

  it("finding references in the old form still count", () => {
    expect(refLength("Gate 1 #2: add a limit", 2)).toBe("Gate 1 #2".length);
    expect(refLength("Security and Testability Review #2: add a limit", 2)).toBe("Security and Testability Review #2".length);
    expect(refLength("Gate 1 #12: x", 1)).toBe(0);
    expect(citesFinding("Gate 1 #2, #3; D-0004", 3)).toBe(true);
    expect(citesFinding("Gate1 #3", 3)).toBe(true);
    expect(citesFinding("Security and Testability Review #3", 3)).toBe(true);
    expect(citesFinding("analyst", 3)).toBe(false);
    const findings = [{ n: 1, criterion: "S1.1", severity: "Low", fix: "Cap the input.", explanation: "x", needs_owner: false }] as never;
    expect(stReviewQuestionProblem("Gate 1 #1: cap it?", "Something else", findings)).toMatch(/word for word/);
    expect(stReviewQuestionProblem("Gate 1 #1: cap it?", "Cap the input.", findings)).toBeNull();
  });

  it("a spec with the old section 9 source header passes the structure check", () => {
    const spec = ["# Feature: Export", "", "- **Spec version:** 1", ""];
    for (const s of SPEC_SECTIONS) {
      spec.push(s.heading, "Text.");
      if (s.table) {
        const t = s.table.map((c) => (c === "Source (analyst / Security and Testability Review)" ? "Source (analyst / Gate 1)" : c));
        spec.push(`| ${t.join(" | ")} |`, `|${t.map(() => "---").join("|")}|`);
      }
      spec.push("");
    }
    expect(structureProblems(spec.join("\n"))).toEqual([]);
  });

  it("a limits file with the old section name still loads, but not with both names", () => {
    const shipped = YAML.parse(fs.readFileSync(path.join(__dirname, "..", "config", "limits.yaml"), "utf8")) as Record<string, unknown>;
    const { security_testability_review: sec, ...rest } = shipped;
    expect(parseLimits({ ...rest, security_gate_1: sec }, LIMITS_FILE, true).security_testability_review).toEqual(sec);
    expect(() => parseLimits({ ...shipped, security_gate_1: sec }, LIMITS_FILE, true)).toThrow(/names both/);
    expect(parseLimits({ security_gate_1: { runs_per_feature: 1 } }, "manifest", false).security_testability_review).toEqual({ runs_per_feature: 1 });
    expect(limitsFile.safeParse({ ...rest, security_gate_1: sec }).success).toBe(true);
  });
});
