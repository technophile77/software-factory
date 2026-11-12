// Feature specs written into the analyst's worktree, in the shape of
// docs/features/feature-template.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, tryGit } from "./world";

export interface AssumptionRow {
  id: string;
  text: string;
  link: string;
  status: string;
}

export function specText(feature: string, assumptions: AssumptionRow[] = [], extra = ""): string {
  const rows = assumptions.map((a) => `| ${a.id} | ${a.text} | ${a.link} | ${a.status} |`).join("\n");
  return `# Feature: CSV export

- **Id:** ${feature}
- **Status:** In review
- **Requested by / date:** Owner, 2026-11-11
- **Spec version:** 3

## 1. Objective and business purpose
Let people export their data as CSV.

## 2. Expected behavior
A button downloads a CSV file.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Export all rows as CSV. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given rows, when export is pressed, then a CSV with every row downloads. | FR-1 |

## 5. Constraints
None.

## 6. Edge cases
Empty table.

## 7. Dependencies
None.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
${rows}

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Escape formulas in cells. | Analyst | Draft |

## 10. Interface requirements
None.
${extra}
## 11. Readiness gate
- [ ] Clear objective

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 3 | 2026-11-11 | Interview | — |
`;
}

/** The spec's path, relative to the worktree, for a feature. */
export function specPath(feature: string, slug = "csv-export") {
  return `docs/features/${feature}-${slug}.md`;
}

/** Writes and commits the spec on the analyst's branch, as an agent edit
 * followed by the engine's commit would leave it. */
export function writeSpec(worktree: string, rel: string, text: string) {
  const abs = join(worktree, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  commitAll(worktree, "spec");
}

export function commitAll(worktree: string, msg: string) {
  git(worktree, "add", "-A");
  tryGit(worktree, "commit", "-q", "--no-verify", "-m", msg);
}

/** Row for an assumption the owner approved in the interview, with both the
 * engine's item id and the exact text, so it matches whichever the engine
 * keys on. */
export function approvedRow(item: { id: string; text: string }): AssumptionRow {
  return { id: item.id, text: item.text, link: `Owner, interview 2026-11-11 (item ${item.id})`, status: "Approved" };
}
