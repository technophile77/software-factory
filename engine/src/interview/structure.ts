import template from "../../../docs/features/feature-template.structure.json";
import { SECTION9_SOURCE_HEADERS } from "../legacy-names";

/**
 * F-016 FR-17: the spec's headings and table header rows must match
 * docs/features/feature-template.structure.json word for word. The engine's
 * readers find sections by these exact headings, so a spec that drifts from
 * them is refused at interview_spec_ready instead of being misread later.
 * Problems name line numbers and template text only, never spec text.
 */

interface Section {
  heading: string;
  table?: string[];
}

export const SPEC_SECTIONS: readonly Section[] = (template as { sections: Section[] }).sections;

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;

/** The template's header row, and section 9's pre-rename form, which specs written before it keep. */
const headerRows = (table: string[]): string[] => {
  const [now, old] = SECTION9_SOURCE_HEADERS;
  return table.includes(now!) ? [row(table), row(table.map((c) => (c === now ? old! : c)))] : [row(table)];
};

/** The structure as the analyst's instructions state it. */
export function structureText(): string {
  const lines = SPEC_SECTIONS.map((s) => (s.table ? `${s.heading}, whose first table's header row is ${row(s.table)}` : s.heading));
  return [
    "Use exactly these level-2 headings, in this order, each once, and these table header rows; the engine refuses a spec that differs:",
    ...lines.map((l) => `- ${l}`),
    "Any other level-2 section (such as ## Sources) goes after section 12. Level-3 and lower headings may appear inside any section.",
  ].join("\n");
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

export function structureProblems(spec: string): string[] {
  const lines = spec.split(/\r?\n/);
  const level2: Array<{ i: number; text: string }> = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) fence = !fence;
    else if (!fence && /^##\s/.test(l)) level2.push({ i, text: l.trimEnd() });
  });

  const problems: string[] = [];
  const found = SPEC_SECTIONS.map((s) => level2.filter((h) => h.text === s.heading));
  let last = -1;
  SPEC_SECTIONS.forEach((s, k) => {
    const hits = found[k]!;
    if (!hits.length) {
      problems.push(`the heading "${s.heading}" is missing; write it exactly so`);
      return;
    }
    if (hits.length > 1) problems.push(`"${s.heading}" appears more than once (lines ${hits.map((h) => h.i + 1).join(", ")})`);
    const at = hits[0]!.i;
    if (at < last) problems.push(`line ${at + 1}: "${s.heading}" is out of order; the sections go 1 to ${SPEC_SECTIONS.length}`);
    last = Math.max(last, at);
    if (s.table) {
      const next = level2.find((h) => h.i > at);
      const body = lines.slice(at + 1, next ? next.i : lines.length);
      const header = body.findIndex((l) => l.trim().startsWith("|"));
      if (header < 0) problems.push(`section "${s.heading}" has no table; its header row must be ${row(s.table)}`);
      else if (!headerRows(s.table).includes(row(cells(body[header]!)))) problems.push(`line ${at + 2 + header}: the first table under "${s.heading}" must have the header row ${row(s.table)}`);
    }
  });

  const known = new Set(SPEC_SECTIONS.map((s) => s.heading));
  const end = found[found.length - 1]![0]?.i ?? Infinity;
  for (const h of level2) {
    if (!known.has(h.text) && h.i < end) problems.push(`line ${h.i + 1}: a level-2 heading the template doesn't have; use the template's heading, make it level 3 inside a section, or move it after "${SPEC_SECTIONS[SPEC_SECTIONS.length - 1]!.heading}"`);
  }
  return problems;
}
