import { z } from "zod";
import type { ItemInput, Part } from "../inbox/model";
import catalog from "./catalog.json";
import { diffHash } from "../inbox/auto-merge";
import { type PlannedFile, type PlannedJob, prFiles } from "./plan";
import { checkName } from "./render";

/**
 * F-026 FR-7, SR-6, SR-12: the hygiene item for one repo's planned CI jobs,
 * and the change record the engine keeps on factory/state until the owner
 * answers. The item's diff hash is the approval's identity: what lands must
 * be exactly what the owner was shown.
 */

export const CI_CHANGE_SCHEMA = "ci-change/1.0";

export const ciChange = z.strictObject({
  schema: z.literal(CI_CHANGE_SCHEMA),
  feature: z.string().regex(/^F-\d{3,6}$/),
  repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
  /** The main commit the plan was made from. */
  base: z.string().regex(/^[0-9a-f]{40}$/),
  jobs: z.array(z.strictObject({ job: z.string().max(40), action: z.enum(["add", "update", "remove"]), covers: z.array(z.string().max(300)).max(200), check: z.string().max(60) })).min(1).max(20),
  files: z.array(z.strictObject({ path: z.string().max(300), content: z.string().max(100_000).nullable(), before: z.string().max(100_000).nullable() })).min(1).max(20),
  diff: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CiChange = z.infer<typeof ciChange>;

/** The approval's identity for these files (FR-7). */
export const filesDiff = (files: readonly PlannedFile[]) => diffHash(prFiles(files));

export function changeRecord(feature: string, repo: string, base: string, jobs: readonly PlannedJob[]): CiChange {
  const files = jobs.map((j) => j.file);
  return {
    schema: CI_CHANGE_SCHEMA, feature, repo, base,
    jobs: jobs.map((j) => ({ job: j.request.job, action: j.request.action, covers: j.request.covers, check: checkName(j.request.job) })),
    files: files.map((f) => ({ path: f.path, content: f.content, before: f.before })),
    diff: filesDiff(files),
  };
}

const AUTHOR = "the test engineer";
const RENDERED = "the engine, from the test engineer's request";

export function ciJobsItem(o: { feature: string; repo: string; jobs: readonly PlannedJob[]; record: string; diff: string; key: string }): ItemInput {
  const names = o.jobs.map((j) => j.request.job);
  const flagged = o.jobs.filter((j) => j.flags.length);
  const file: Part[] = o.jobs.map((j) => ({ engine: `- \`${j.file.path}\`: ${j.request.action} job \`${j.request.job}\`, check \`${checkName(j.request.job)}\`${j.request.action !== "remove" && "template" in j.request ? `, template \`${j.request.template}\`` : ""}.` }));
  const diff: Part[] = o.jobs.flatMap((j): Part[] => [
    { engine: `**${j.file.path}**${j.file.before === null ? " (new file)" : j.file.content === null ? " (removed)" : ""}` },
    ...(j.file.before !== null ? [{ engine: "Current content:" }, { outside: j.file.before, author: "the file on main" }] : []),
    ...(j.file.content !== null ? [{ engine: j.file.before !== null ? "Proposed content:" : "Content:" }, { outside: j.file.content, author: RENDERED }] : []),
  ]);
  const risks: Part[] = [
    { engine: catalog.risks.common },
    ...[...new Set(o.jobs.flatMap((j) => (j.request.action === "remove" ? [] : [j.request.template])))].map((t) => ({ engine: `${t}: ${catalog.risks[t]}` })),
    ...o.jobs.filter((j) => j.scheduled).map((j) => ({ engine: `\`${j.request.job}\` runs on a weekly schedule, up to ${j.timeout} minutes a run. ${catalog.risks.schedule}` })),
    ...flagged.map((j) => ({ engine: `\`${j.request.job}\`'s commands name a network tool, an address or a package index the catalog flags: ${j.flags.map((x) => `\`${x.replace(/`/g, "'")}\``).join(", ")}. On a private repo such a command could send the code out.` })),
  ];
  const recommendation: Part[] = flagged.length
    ? [{ engine: `Reject: ${flagged.map((j) => `\`${j.request.job}\``).join(", ")} ${flagged.length > 1 ? "have" : "has"} a flagged command (F-026 SR-6). Rejecting sends your note to the test engineer.` }]
    : [{ engine: `Approve. The engine then pushes these files on their own branch with the CI token, opens a pull request and merges it once its required checks pass and its files are exactly these. Then mark ${o.jobs.filter((j) => j.request.action !== "remove").map((j) => `\`${checkName(j.request.job)}\``).join(", ") || "nothing new"} required on main in GitHub's branch settings if ${o.feature} relies on ${o.jobs.length > 1 ? "them" : "it"}.` }];
  return {
    kind: "hygiene",
    title: `CI jobs for ${o.feature} in ${o.repo}: ${names.join(", ")}`.slice(0, 200),
    priority: "medium",
    blocking: false,
    repo: o.repo,
    feature: o.feature,
    created_by: "engine",
    key: o.key,
    effect: { type: "ci_jobs", feature: o.feature, repo: o.repo, record: o.record, diff: o.diff },
    links: [{ kind: "file", ref: o.record }, { kind: "url", ref: `https://github.com/${o.repo}/settings/branches` }],
    sections: {
      File: file,
      Reason: o.jobs.map((j) => ({ outside: `${j.request.job}: ${j.request.reason}${j.request.covers.length ? `\nCovers: ${j.request.covers.join(", ")}` : ""}`, author: AUTHOR })),
      Diff: diff,
      Benefits: [{ engine: `${o.feature}'s tests and checks run in ${o.repo}'s CI on every pull request, so tests that can't run on your PC are still run before a merge.` }],
      Risks: risks,
      Recommendation: recommendation,
    },
  };
}
