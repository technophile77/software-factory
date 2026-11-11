import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSources } from "../config/agent-sources";
import { ensureOwnerDir } from "../fsutil";
import { ROLE_RE } from "../policy/role-policy";
import { DockerCli, DockerError } from "./cli";

/** The base image, by multi-arch index digest (Gate 1 review 4, OQ-6). Agent images and the proxy sidecar both start from it. */
export const BASE_IMAGE_DIGEST = "sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072";
export const BASE_IMAGE = `node:26.13.0-trixie-slim@${BASE_IMAGE_DIGEST}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID_RE = /^sha256:[0-9a-f]{64}$/;

/** The local id of the pinned base image, pulling it by digest if needed; refuses an image that isn't the pinned one. */
export async function baseImageId(docker: DockerCli): Promise<string> {
  const have = await docker.run(["image", "inspect", BASE_IMAGE], { okCodes: [1] });
  if (have.code !== 0) await docker.run(["pull", BASE_IMAGE], { timeoutMs: 15 * 60_000 });
  const doc = JSON.parse(await docker.out(["image", "inspect", BASE_IMAGE])) as unknown;
  const img = Array.isArray(doc) ? doc[0] : doc;
  if (!isObj(img) || typeof img.Id !== "string" || !ID_RE.test(img.Id)) throw new DockerError("the base image has no id");
  const digests = Array.isArray(img.RepoDigests) ? img.RepoDigests.map(String) : [];
  if (!digests.some((d) => d.endsWith(`@${BASE_IMAGE_DIGEST}`))) throw new DockerError("the base image doesn't carry the pinned digest");
  return img.Id;
}

/** Where a role's baked skills sit in the image, as a local plugin folder (SR-10). */
export const SKILLS_ROOT = "/opt/factory/skills";
export function skillsPluginDir(role: string): string {
  if (!ROLE_RE.test(role)) throw new DockerError("bad role name");
  return `${SKILLS_ROOT}/${role}`;
}

/** The engine's own files the build needs; nothing else of the engine's docker folder is copied. */
const ENGINE_FILES = ["agent.Dockerfile", "claude-code/package.json", "claude-code/package-lock.json", "claude-sha256.json", "verify-claude.cjs"];

/**
 * Assembles a fresh build context: the engine's own image files, and under
 * `skills/<role>/` a local plugin holding that role's resolved skills (spec
 * v30). Skill files come from git objects only; nothing of a working tree or
 * a worktree is copied.
 */
export function writeBuildContext(engineDockerDir: string, contextDir: string, sources: Pick<AgentSources, "skills">): void {
  fs.rmSync(contextDir, { recursive: true, force: true });
  ensureOwnerDir(contextDir);
  for (const f of ENGINE_FILES) {
    fs.mkdirSync(path.dirname(path.join(contextDir, f)), { recursive: true });
    fs.copyFileSync(path.join(engineDockerDir, f), path.join(contextDir, f));
  }
  const root = path.join(contextDir, "skills");
  fs.mkdirSync(root);
  for (const [role, list] of sources.skills) {
    skillsPluginDir(role);
    const plugin = path.join(root, role);
    fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: `factory-${role}`, version: "0.0.0", description: `Skills baked for the ${role} role` }, null, 2)}\n`);
    for (const s of list) {
      for (const [rel, f] of s.files) {
        // Paths come from git trees, so they are already relative and free of '..'; checked again before writing.
        if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) throw new DockerError("bad skill file path");
        const dest = path.join(plugin, "skills", s.name, ...rel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content, { mode: f.executable ? 0o755 : 0o644 });
      }
    }
  }
}

export interface ImageIdentity {
  project: string;
  /** The master commit `factory.version` names. */
  masterCommit: string;
  /** AgentSources.skillsDigest: project overrides differ per project even on one master commit. */
  skillsDigest: string;
}

export function agentImageTag(id: ImageIdentity): string {
  const project = id.project.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `factory-agent:${project}-${id.masterCommit.slice(0, 12)}-${id.skillsDigest.slice(0, 12)}`;
}

/**
 * `docker buildx build` for the agent image; the context is one
 * `writeBuildContext` made, never a project's files. Always BuildKit: the
 * legacy builder leaves TARGETARCH unset and its intermediate containers
 * unlabelled, where the sweep can't find them.
 */
export function agentBuildArgs(contextDir: string, iidFile: string, id: ImageIdentity): string[] {
  if (!path.isAbsolute(contextDir) || !path.isAbsolute(iidFile)) throw new DockerError("absolute paths only");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id.project)) throw new DockerError("bad project name");
  if (!/^[0-9a-f]{40,64}$/.test(id.masterCommit) || !/^[0-9a-f]{64}$/.test(id.skillsDigest)) throw new DockerError("bad image identity");
  return ["buildx", "build", "--load", "--build-arg", `BASE_IMAGE=${BASE_IMAGE}`, "--iidfile", iidFile, "--tag", agentImageTag(id),
    "--label", `factory.project=${id.project}`, "--label", `factory.master_commit=${id.masterCommit}`, "--label", `factory.skills_sha256=${id.skillsDigest}`,
    "--file", path.join(contextDir, "agent.Dockerfile"), contextDir];
}

/**
 * The project's agent image for its master commit and resolved skills: the
 * one already tagged for them if its labels and user check out, else a fresh
 * build. Docker reuses layers, so an unchanged identity costs one inspect.
 */
export async function ensureAgentImage(docker: DockerCli, engineDockerDir: string, workDir: string, ident: ImageIdentity, sources: Pick<AgentSources, "skills">): Promise<{ id: string; tag: string }> {
  const tag = agentImageTag(ident);
  const have = await docker.run(["image", "inspect", tag], { okCodes: [1] });
  if (have.code === 0) {
    const doc = JSON.parse(have.stdout.toString()) as unknown;
    const img = Array.isArray(doc) ? doc[0] : doc;
    const labels = isObj(img) && isObj(img.Config) && isObj(img.Config.Labels) ? img.Config.Labels : {};
    if (isObj(img) && typeof img.Id === "string" && ID_RE.test(img.Id) && isObj(img.Config) && img.Config.User === "1000:1000"
      && labels["factory.master_commit"] === ident.masterCommit && labels["factory.skills_sha256"] === ident.skillsDigest && labels["factory.project"] === ident.project) {
      return { id: img.Id, tag };
    }
  }
  return { id: await buildAgentImage(docker, engineDockerDir, workDir, ident, sources), tag };
}

/** The build needs the buildx plugin; without it the engine says so rather than fall back to the legacy builder. */
export async function requireBuildx(docker: DockerCli): Promise<void> {
  try {
    await docker.run(["buildx", "version"]);
  } catch (e) {
    throw new DockerError(`the docker buildx plugin wasn't found, and the agent image is built only with BuildKit: install or repair buildx (Docker Desktop includes it). ${(e as Error).message}`);
  }
}

export async function buildAgentImage(docker: DockerCli, engineDockerDir: string, workDir: string, ident: ImageIdentity, sources: Pick<AgentSources, "skills">): Promise<string> {
  await baseImageId(docker);
  await requireBuildx(docker);
  const context = path.join(workDir, `agent-context-${ident.masterCommit.slice(0, 12)}-${ident.skillsDigest.slice(0, 12)}`);
  writeBuildContext(engineDockerDir, context, sources);
  const iid = path.join(workDir, `agent-image-${ident.project}.iid`);
  fs.rmSync(iid, { force: true });
  try {
    await docker.run(agentBuildArgs(context, iid, ident), { timeoutMs: 30 * 60_000 });
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  const id = fs.readFileSync(iid, "utf8").trim();
  if (!ID_RE.test(id)) throw new DockerError("the build gave no image id");
  const doc = JSON.parse(await docker.out(["image", "inspect", id])) as unknown;
  const img = Array.isArray(doc) ? doc[0] : doc;
  if (!isObj(img) || !isObj(img.Config) || img.Config.User !== "1000:1000") throw new DockerError("the agent image doesn't run as the non-root user");
  const labels = isObj(img.Config.Labels) ? img.Config.Labels : {};
  if (labels["factory.master_commit"] !== ident.masterCommit || labels["factory.skills_sha256"] !== ident.skillsDigest) throw new DockerError("the agent image doesn't carry its master commit and skills");
  return id;
}
