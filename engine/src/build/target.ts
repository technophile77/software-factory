/**
 * F-015 FR-16 and H-0198: which code repo a feature builds in, and which
 * features of its project it waits for, read from its approved spec.
 */

export class TargetError extends Error {
  override name = "TargetError";
}

const REPO_LINE_RE = /^- \*\*Repo:\*\*[ \t]*(.*?)[ \t]*$/m;

/** The spec's `- **Repo:**` header line, or the project's only repo when there is none. */
export function targetRepo<R extends { name: string }>(spec: string, repos: readonly R[]): R {
  const header = spec.split(/^## /m, 1)[0] ?? "";
  const m = REPO_LINE_RE.exec(header);
  if (!m) {
    if (repos.length === 1) return repos[0]!;
    throw new TargetError(`the spec names no repo and the project has ${repos.length}; add a "- **Repo:** <name>" line to its header`);
  }
  const name = m[1]!.replace(/^`|`$/g, "");
  const found = repos.find((r) => r.name === name);
  if (!found) throw new TargetError(`the spec's Repo line names a repo the project doesn't have`);
  return found;
}

/** Feature ids in section 7 Dependencies, without the feature itself, in order of first mention. */
export function specDependencies(spec: string, self: string): string[] {
  const start = /^## 7\. Dependencies[^\n]*$/m.exec(spec);
  if (!start) return [];
  const rest = spec.slice(start.index + start[0].length);
  const end = /^## /m.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;
  const ids: string[] = [];
  for (const m of section.matchAll(/\bF-\d{3,6}\b/g)) if (m[0] !== self && !ids.includes(m[0])) ids.push(m[0]);
  return ids;
}
