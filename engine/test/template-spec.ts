import { SPEC_SECTIONS } from "../src/interview/structure";

/**
 * Every template section with its exact heading (F-016 FR-17). `bodies` replaces a
 * section's body by number; a table section's body then starts after its header row.
 */
export function templateSections(bodies: Record<number, string[]> = {}): string[] {
  return SPEC_SECTIONS.flatMap((s, k) => {
    const body = bodies[k + 1];
    const header = s.table ? [`| ${s.table.join(" | ")} |`, `|${s.table.map(() => "---").join("|")}|`] : [];
    return [s.heading, ...header, ...(body ?? (s.table ? [] : ["None."])), ""];
  });
}
