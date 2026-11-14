import type { StReviewReport } from "./report";
import { recordedOnly } from "./flow";

/**
 * SR-4: reviewer text shown as plain text in Markdown. Every character that
 * Markdown or HTML could read as structure is escaped, so a link, an image, a
 * tag, a heading or a table cell break stays literal text. Line breaks become
 * spaces, as a table cell can't hold them.
 */
export function plain(s: string): string {
  return s
    .replace(/\r\n?|\n/g, " ")
    .replace(/[\\`*_{}[\]()#+\-.!|<>~&"':=]/g, (c) => `\\${c}`)
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A finding's number in the report, as specs and questions cite it. */
export const findingRef = (n: number) => `Security and Testability Review #${n}`;

/**
 * FR-6: `docs/features/<feature>-security-testability-review.md`, in the layout the
 * factory's own Security and Testability Review reports use. Engine text is written as is; every
 * reviewer string goes through `plain`.
 */
export function renderReport(o: { feature: string; title: string; specVersion: number | null; date: string; runId: string; report: StReviewReport; maturity?: string }): string {
  const r = o.report;
  const isKnown = (f: StReviewReport["findings"][number]) => !!o.maturity && recordedOnly(f, o.maturity);
  const known = r.findings.filter(isKnown).length;
  const choices = r.findings.filter((f) => f.needs_owner && !isKnown(f)).length;
  const result = r.findings.length === 0
    ? "No findings."
    : `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}; ${r.findings.length - choices - known} sent to the requirements analyst as requirements for the owner to approve in the interview, ${choices} filed as Security items for the owner's choice${known ? `, ${known} below this maturity level's bar recorded as known issues, to fix before promotion` : ""}.`;
  const out = [
    `# ${o.feature} Security and Testability Review (requirements review)`,
    "",
    `- **Feature:** ${o.feature} ${plain(o.title)}${o.specVersion !== null ? `, spec v${o.specVersion}` : ""}`,
    "- **Reviewer role:** security-reviewer, against `docs/security-standards.md`",
    `- **Date:** ${o.date}`,
    `- **Run:** ${o.runId}`,
    `- **Result:** ${result}`,
    "",
    `**Summary (reviewer's words):** ${plain(r.summary)}`,
    "",
  ];
  if (r.findings.length) {
    out.push("| # | Criterion | Severity | Blocks | Location | Finding | Resolution |", "|---|---|---|---|---|---|---|");
    r.findings.forEach((f, i) => {
      const resolution = isKnown(f)
        ? `Known issue, open until fixed before promotion: ${plain(f.fix)}`
        : f.needs_owner
          ? `Owner's choice: ${f.options!.map((op) => `${op.id}. ${plain(op.label)}`).join("; ")} (recommended ${f.recommendation})`
          : plain(f.fix);
      out.push(`| ${i + 1} | ${plain(f.criterion)} | ${plain(f.severity)} | ${f.blocks ? "Yes" : "No"} | ${plain(f.location)} | ${plain(f.explanation)} | ${resolution} |`);
    });
    out.push("");
  }
  out.push("## Security and Testability Review checklist", "", "| Question | Answer |", "|---|---|");
  for (const c of r.checklist) out.push(`| ${plain(c.question)} | ${plain(c.answer)} |`);
  out.push("");
  const list = (head: string, items: string[]) => {
    out.push(`**${head}:** ${items.length ? "" : "None."}`);
    for (const i of items) out.push(`- ${plain(i)}`);
    out.push("");
  };
  list("Permissions this feature adds (S8.5)", r.permissions_added);
  list("Abuse cases", r.abuse_cases);
  list("Not applicable", r.not_applicable.map((n) => `${n.criterion}: ${n.reason}`));
  return out.join("\n");
}
