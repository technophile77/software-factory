import * as crypto from "node:crypto";
import type { Git } from "../git";
import { CORE_ROLES, ROLE_RE } from "../policy/role-policy";
import { LIMITS_FILE } from "./limits";
import { MODELS_FILE } from "./models";
import { SourceError, TreeFile, TreeSnapshot, checkRepoPath, readDirAt, readFileAt } from "./factory-source";

/** Proposal 0013: the protected skill. The six core agents are protected too. */
export const PROTECTED_SKILLS = ["security-review"];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DECISION_RE = /^D-\d{4,}$/;
// Bounds on what one project can put into an image or a prompt; the engine's own guard, not owner limits.
const AGENT_MD_MAX = 256 * 1024;
const SKILL_BOUNDS = { files: 100, bytes: 2 * 1024 * 1024 };

/** What the engine reads from the master commit at every start: agent sources, the limit defaults and the models. */
export const MASTER_SOURCE_PATHS = ["skills", "agents", LIMITS_FILE, MODELS_FILE];

export type SourceOrigin = "master" | "project";

export interface Instructions {
  text: string;
  from: SourceOrigin;
  path: string;
}

export interface ResolvedSkill {
  name: string;
  from: SourceOrigin;
  path: string;
  files: Map<string, TreeFile>;
}

export interface AgentSources {
  /** The master commit `factory.version` names. */
  masterCommit: string;
  /** The config repo's `main` commit the project's overrides were read from. */
  configCommit: string;
  /** Each role's `AGENT.md`; a role with none here may not run. */
  instructions: Map<string, Instructions>;
  /** The skills baked into the image for each role. */
  skills: Map<string, ResolvedSkill[]>;
  /** Over every role's skill files: part of the image's label and tag. */
  skillsDigest: string;
}

interface Entry {
  name: string;
  path?: string;
  reason?: string;
  decision?: string;
  agents?: string[];
}

interface Block {
  custom: Entry[];
  override: Entry[];
  exclude: Entry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readBlock(doc: Record<string, unknown>, section: "skills" | "agents"): Block {
  const raw = doc[section];
  const out: Block = { custom: [], override: [], exclude: [] };
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) throw new SourceError(`${section} must be a mapping.`);
  for (const k of Object.keys(raw)) if (!(k in out)) throw new SourceError(`${section}.${k} is not a known key.`);
  for (const kind of ["custom", "override", "exclude"] as const) {
    const list = raw[kind];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new SourceError(`${section}.${kind} must be a list.`);
    list.forEach((e, i) => {
      const at = `${section}.${kind}[${i}]`;
      if (!isObj(e) || typeof e.name !== "string" || !NAME_RE.test(e.name)) throw new SourceError(`${at} needs a name of lowercase letters, digits, '.', '_' or '-'.`);
      if (section === "agents" && !ROLE_RE.test(e.name)) throw new SourceError(`${at}: ${e.name} is not a role name.`);
      const entry: Entry = { name: e.name };
      if (kind !== "exclude") entry.path = checkRepoPath(e.path, `${at}.path`);
      if (kind !== "custom") {
        if (typeof e.reason !== "string" || !e.reason.trim()) throw new SourceError(`${at} (${e.name}) needs a reason.`);
        entry.reason = e.reason;
      }
      if (e.decision !== undefined) {
        if (typeof e.decision !== "string" || !DECISION_RE.test(e.decision)) throw new SourceError(`${at}.decision must be D-nnnn.`);
        entry.decision = e.decision;
      }
      if (e.agents !== undefined) {
        if (section !== "skills" || kind !== "custom") throw new SourceError(`${at}.agents is only for skills.custom.`);
        if (!Array.isArray(e.agents) || !e.agents.every((a) => typeof a === "string" && ROLE_RE.test(a))) throw new SourceError(`${at}.agents must list role names.`);
        entry.agents = e.agents as string[];
      }
      out[kind].push(entry);
    });
  }
  const seen = new Set<string>();
  for (const e of [...out.custom, ...out.override, ...out.exclude]) {
    if (seen.has(e.name)) throw new SourceError(`${section}: ${e.name} is listed more than once across custom, override and exclude.`);
    seen.add(e.name);
  }
  return out;
}

function checkAgainstMaster(section: "skills" | "agents", b: Block, master: Set<string>, protectedNames: string[]): void {
  for (const e of b.override) {
    if (!master.has(e.name)) throw new SourceError(`${section}.override: ${e.name} is not a default in the pinned master version.`);
    if (protectedNames.includes(e.name) && !e.decision) throw new SourceError(`${section}.override: ${e.name} is protected and needs an approved Security decision (decision: D-nnnn).`);
  }
  for (const e of b.exclude) {
    if (protectedNames.includes(e.name)) throw new SourceError(`${section}.exclude: ${e.name} is protected and can never be excluded.`);
    if (!master.has(e.name)) throw new SourceError(`${section}.exclude: ${e.name} is not a default in the pinned master version.`);
  }
  for (const e of b.custom) {
    if (master.has(e.name)) throw new SourceError(`${section}.custom: ${e.name} is a master default; use override to replace it.`);
  }
}

function skillDir(path: string, what: string): string {
  if (!path.endsWith("/SKILL.md")) throw new SourceError(`${what} must point to a SKILL.md inside a folder.`);
  return path.slice(0, -"/SKILL.md".length);
}

/**
 * The effective agents and skills for a project (proposal 0013, spec v30):
 * the master defaults at `masterCommit`, then the project's `skills` and
 * `agents` blocks from its config repo's `main` commit on top. A project's
 * override or custom entry always wins, so a newer master never replaces
 * it. Every file is read from git objects; a link, a path out of the repo or
 * a missing file refuses the project.
 */
export async function resolveAgentSources(i: {
  git: Git;
  masterRepo: string;
  masterCommit: string;
  configRepo: string;
  configCommit: string;
  manifest: unknown;
  /** The master listing, when the caller already took one with `MASTER_SOURCE_PATHS`. */
  masterTree?: TreeSnapshot;
}): Promise<AgentSources> {
  const doc = isObj(i.manifest) ? i.manifest : {};
  const skillsBlock = readBlock(doc, "skills");
  const agentsBlock = readBlock(doc, "agents");

  const tree = i.masterTree ?? (await TreeSnapshot.read(i.git, i.masterRepo, i.masterCommit, MASTER_SOURCE_PATHS));
  const masterSkills = new Set(tree.subfolders("skills").filter((n) => NAME_RE.test(n) && tree.has(`skills/${n}/SKILL.md`)));
  const masterAgents = new Set(tree.subfolders("agents").filter((n) => ROLE_RE.test(n)));
  checkAgainstMaster("skills", skillsBlock, masterSkills, PROTECTED_SKILLS);
  checkAgainstMaster("agents", agentsBlock, masterAgents, CORE_ROLES);

  const policyRoles = isObj(doc.policy) && isObj(doc.policy.roles) ? Object.keys(doc.policy.roles).filter((r) => ROLE_RE.test(r)) : [];
  const roles = [...new Set([...policyRoles, ...agentsBlock.custom.map((e) => e.name)])].sort();

  // Master files are listed and bounds-checked first, then read in one batch.
  const instructions = new Map<string, Instructions>();
  const masterInstructions: Array<[string, string, string]> = [];
  const excludedAgents = new Set(agentsBlock.exclude.map((e) => e.name));
  for (const role of roles) {
    const own = agentsBlock.override.find((e) => e.name === role) ?? agentsBlock.custom.find((e) => e.name === role);
    if (own) {
      const buf = await readFileAt(i.git, i.configRepo, i.configCommit, own.path!, AGENT_MD_MAX, `agents: ${role}`);
      instructions.set(role, { text: buf.toString("utf8"), from: "project", path: own.path! });
    } else if (masterAgents.has(role) && !excludedAgents.has(role)) {
      const p = `agents/${role}/AGENT.md`;
      if (tree.has(p)) masterInstructions.push([role, p, tree.fileSha(p, AGENT_MD_MAX, "master")]);
    }
  }

  // Each skill is read once and shared by every role that gets it.
  const project = new Map<string, ResolvedSkill>();
  for (const e of [...skillsBlock.override, ...skillsBlock.custom]) {
    const dir = skillDir(e.path!, `skills: ${e.name} path`);
    project.set(e.name, { name: e.name, from: "project", path: dir, files: await readDirAt(i.git, i.configRepo, i.configCommit, dir, SKILL_BOUNDS, `skills: ${e.name}`) });
  }
  const excluded = new Set(skillsBlock.exclude.map((e) => e.name));
  const masterSkillFiles = new Map<string, Array<[string, string, boolean]>>();
  for (const n of [...masterSkills].sort()) {
    if (excluded.has(n) || project.has(n)) continue;
    masterSkillFiles.set(n, tree.dirFiles(`skills/${n}`, SKILL_BOUNDS, "master skill"));
  }
  const blobs = await tree.blobs([...masterInstructions.map(([, , sha]) => sha), ...[...masterSkillFiles.values()].flat().map(([, sha]) => sha)]);
  for (const [role, p, sha] of masterInstructions) instructions.set(role, { text: blobs.get(sha)!.toString("utf8"), from: "master", path: p });
  const master = new Map<string, ResolvedSkill>();
  for (const [n, files] of masterSkillFiles) {
    master.set(n, { name: n, from: "master", path: `skills/${n}`, files: new Map(files.map(([rel, sha, executable]) => [rel, { content: blobs.get(sha)!, executable }])) });
  }
  const skills = new Map<string, ResolvedSkill[]>();
  for (const role of roles) {
    const list: ResolvedSkill[] = [...master.values()];
    for (const e of skillsBlock.override) list.push(project.get(e.name)!);
    for (const e of skillsBlock.custom) if (!e.agents || e.agents.includes(role)) list.push(project.get(e.name)!);
    skills.set(role, list.sort((a, b) => (a.name < b.name ? -1 : 1)));
  }

  const h = crypto.createHash("sha256");
  for (const [role, list] of skills) {
    for (const s of list) {
      for (const [rel, f] of [...s.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        h.update(`${role}\0${s.name}\0${rel}\0${f.executable ? 1 : 0}\0${f.content.length}\0`).update(f.content);
      }
    }
  }
  return { masterCommit: i.masterCommit, configCommit: i.configCommit, instructions, skills, skillsDigest: h.digest("hex") };
}
