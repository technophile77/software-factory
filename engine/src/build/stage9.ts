import YAML from "yaml";
import type { CheckRun, RequiredCheck } from "./pulls";

/**
 * Stage 9 rules as code (F-015 FR-10, SR-3, SR-4, SR-11, SR-13): what counts
 * as green CI, which workflows may see a pull request, and what may never
 * leave the owner's PC.
 */

/** GitHub Actions' app id: a required check with no pinned app must come from Actions (SR-3). */
export const ACTIONS_APP_ID = 15368;
const PASSING = new Set(["success", "neutral", "skipped"]);

export type ChecksVerdict = { state: "green" } | { state: "pending"; waiting: string[] } | { state: "red"; failed: CheckRun[] };

/**
 * SR-3, SR-11: only the `main` ruleset's required checks count, each from its
 * pinned app, on the exact SHA the engine pushed; any other run is ignored.
 * With no required checks, CI has nothing to wait for (definition of done
 * item 12 at Rapid prototype, ADR 0030).
 */
export function checksVerdict(required: readonly RequiredCheck[], runs: readonly CheckRun[], sha: string): ChecksVerdict {
  const waiting: string[] = [];
  const failed: CheckRun[] = [];
  for (const req of required) {
    const app = req.integrationId ?? ACTIONS_APP_ID;
    const mine = runs.filter((r) => r.name === req.context && r.headSha === sha && r.appId === app);
    const done = mine.filter((r) => r.status === "completed");
    if (!done.length || done.length < mine.length) waiting.push(req.context);
    else if (done.some((r) => !PASSING.has(r.conclusion ?? ""))) failed.push(...done.filter((r) => !PASSING.has(r.conclusion ?? "")));
  }
  if (failed.length) return { state: "red", failed };
  if (waiting.length) return { state: "pending", waiting };
  return { state: "green" };
}

/**
 * SR-13: workflows a pull request triggers must have read-only permissions,
 * no secret but GITHUB_TOKEN and no deploy environment. `pull_request_target`
 * runs with the base repo's secrets, so it is refused outright.
 */
export function prWorkflowProblems(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const out: string[] = [];
  for (const f of files) {
    let doc: Record<string, unknown>;
    try {
      doc = YAML.parse(f.text, { maxAliasCount: 50 }) as Record<string, unknown>;
    } catch {
      out.push(`${f.path} isn't valid YAML`);
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    const on = doc.on ?? doc.true;
    const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === "object" ? Object.keys(on) : [];
    if (triggers.includes("pull_request_target")) {
      out.push(`${f.path} runs on pull_request_target, which hands pull requests the repo's secrets`);
      continue;
    }
    if (!triggers.includes("pull_request")) continue;
    if (/\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/.test(f.text)) out.push(`${f.path} passes a secret other than GITHUB_TOKEN to pull request runs`);
    const jobs = doc.jobs && typeof doc.jobs === "object" ? Object.entries(doc.jobs as Record<string, Record<string, unknown>>) : [];
    const top = readOnly(doc.permissions);
    for (const [name, job] of jobs) {
      if (job?.environment !== undefined) out.push(`${f.path} job ${name} uses a deploy environment`);
      if (job?.secrets !== undefined) out.push(`${f.path} job ${name} passes secrets to a reusable workflow`);
      const own = job?.permissions === undefined ? top : readOnly(job.permissions);
      if (own !== true) out.push(`${f.path} job ${name} ${own === null ? "doesn't declare permissions" : "has write permissions"}`);
    }
  }
  return out;
}

/** True for read-only permissions, false for any write, null when none are declared. */
function readOnly(p: unknown): boolean | null {
  if (p === undefined || p === null) return null;
  if (typeof p === "string") return p === "read-all" || p === "none" || p === "{}";
  if (typeof p !== "object") return false;
  return Object.values(p as Record<string, unknown>).every((v) => v === "read" || v === "none");
}

const WINDOW = 100;
const MIN_MATCH = 200;
const squash = (s: string) => s.replace(/\s+/g, " ");

/**
 * SR-4, AC-21: the first stretch of at least 200 characters (whitespace
 * folded) that `text` shares with any of `sources`, or null. Any shared
 * stretch that long holds a whole 100-character source window starting at a
 * multiple of 100, so only those windows are indexed.
 */
export function verbatimMatch(text: string, sources: readonly string[]): string | null {
  const windows = new Set<string>();
  const folded = sources.map(squash);
  for (const s of folded) for (let i = 0; i + WINDOW <= s.length; i += WINDOW) windows.add(s.slice(i, i + WINDOW));
  if (!windows.size) return null;
  const t = squash(text);
  for (let i = 0; i + WINDOW <= t.length; i++) {
    const w = t.slice(i, i + WINDOW);
    if (!windows.has(w)) continue;
    for (const s of folded) {
      let at = s.indexOf(w);
      while (at >= 0) {
        let a = 0;
        while (i - a > 0 && at - a > 0 && t[i - a - 1] === s[at - a - 1]) a++;
        let b = WINDOW;
        while (i + b < t.length && at + b < s.length && t[i + b] === s[at + b]) b++;
        if (a + b >= MIN_MATCH) return t.slice(i - a, i + b);
        at = s.indexOf(w, at + 1);
      }
    }
  }
  return null;
}

/**
 * The fixed PR title and description (SR-4): the feature id and title, spec version and the approved spec's commit in the config repo;
 * with `closes`, the source issue the engine checked at start (FR-26), so merging closes it.
 */
export function prText(f: { id: string; title: string; specVersion: number | null; specCommit: string; configRepo: string; specPath: string; closes?: number | null }, ready: boolean): { title: string; body: string } {
  const title = `${f.id}: ${f.title.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim()}`.slice(0, 200);
  const body = [
    `Feature ${f.id}, spec version ${f.specVersion ?? "unknown"}.`,
    `Spec: https://github.com/${f.configRepo}/blob/${f.specCommit}/${f.specPath.split("/").map(encodeURIComponent).join("/")}`,
    "",
    ready ? "The factory's checks have passed: this pull request is ready for the owner's review." : "Draft: the factory is waiting for the required checks.",
    ...(f.closes && Number.isSafeInteger(f.closes) && f.closes > 0 ? ["", `Closes #${f.closes}`] : []),
  ].join("\n");
  return { title, body };
}

/** F-011 FR-9: the definition-of-done comment, engine words only: pass or fail per item and links into the config repo. */
export function doneComment(o: { feature: string; specVersion: number | null; head: string; configRepo: string; items: Array<{ n: number; label: string; met: boolean; ref?: string }>; fork: boolean }): string {
  const link = (ref: string) => `https://github.com/${o.configRepo}/blob/factory/state/${ref.split("/").map(encodeURIComponent).join("/")}`;
  return [
    `**Definition of done for ${o.feature}** (spec version ${o.specVersion ?? "unknown"}, head ${o.head})`,
    "",
    "| # | Item | Result | Evidence |",
    "|---|---|---|---|",
    ...o.items.map((i) => `| ${i.n} | ${i.label} | ${i.met ? "Met" : "Not met"} | ${i.ref ? `[record](${link(i.ref)})` : "-"} |`),
    "",
    o.fork ? "This pull request comes from a fork or an account without write access." : "This pull request comes from a branch in this repo, opened with the owner's token.",
  ].join("\n");
}

/**
 * SR-6 (H-0249): why the engine may not push to a repo, or null when it may.
 * `recorded` is the manifest's `repos[].visibility`: `public` only after the
 * owner confirmed publishing there at onboarding. A repo with nothing
 * recorded may only be private, and any change since onboarding stops pushes.
 */
export function publishRefusal(live: { status: number; private?: boolean }, recorded: "private" | "public" | undefined): string | null {
  if (live.status !== 200 || typeof live.private !== "boolean") return `couldn't be read (HTTP ${live.status})`;
  const now = live.private ? "private" : "public";
  if (recorded === undefined) return now === "private" ? null : "is public, and publishing to it wasn't confirmed at onboarding";
  if (recorded !== now) return `is ${now} but was ${recorded} at onboarding`;
  return null;
}
