/**
 * F-025 SR-5, S9.8: the CVE check of a server's locked dependency tree,
 * through OSV (osv.dev), the database osv-scanner reads. Only package
 * names and versions are sent: no code, paths or secrets (S9.4). A
 * vulnerability whose severity OSV doesn't state counts as high, so an
 * unknown never passes as harmless.
 */

export interface CveCounts {
  tool: string;
  ran_at: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** Advisory ids, for the owner's item. */
  ids: string[];
}

const OSV = "https://api.osv.dev/v1";
const MAX_QUERIES = 1000;
const MAX_DETAILS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function severityOf(vuln: unknown): "critical" | "high" | "medium" | "low" {
  const db = isObj(vuln) && isObj(vuln.database_specific) ? vuln.database_specific.severity : undefined;
  const s = typeof db === "string" ? db.toUpperCase() : "";
  if (s === "CRITICAL") return "critical";
  if (s === "HIGH") return "high";
  if (s === "MODERATE" || s === "MEDIUM") return "medium";
  if (s === "LOW") return "low";
  return "high";
}

export async function osvScan(packages: Array<{ ecosystem: "npm" | "PyPI"; name: string; version: string }>, now: () => string, f: typeof fetch = fetch): Promise<CveCounts> {
  if (packages.length > MAX_QUERIES) throw new Error(`the server pulls in ${packages.length} packages; the CVE check takes at most ${MAX_QUERIES}`);
  const counts: CveCounts = { tool: "osv.dev querybatch", ran_at: now(), critical: 0, high: 0, medium: 0, low: 0, ids: [] };
  if (!packages.length) return counts;
  const post = await f(`${OSV}/querybatch`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ queries: packages.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) }),
  });
  if (!post.ok) throw new Error(`OSV answered HTTP ${post.status}`);
  const body = (await post.json()) as unknown;
  const results = isObj(body) && Array.isArray(body.results) ? body.results : null;
  if (!results || results.length !== packages.length) throw new Error("OSV's answer doesn't match the query");
  const ids = new Set<string>();
  for (const r of results) for (const v of isObj(r) && Array.isArray(r.vulns) ? r.vulns : []) if (isObj(v) && typeof v.id === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(v.id)) ids.add(v.id);
  if (ids.size > MAX_DETAILS) throw new Error(`OSV lists ${ids.size} advisories; too many to check one by one`);
  for (const id of ids) {
    const r = await f(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
    counts[r.ok ? severityOf(await r.json()) : "high"]++;
    counts.ids.push(id);
  }
  return counts;
}
