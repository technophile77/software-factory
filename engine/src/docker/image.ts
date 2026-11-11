import * as fs from "node:fs";
import * as path from "node:path";
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

/** `docker build` for the agent image; the context is the engine's own docker folder, never a project's files. */
export function agentBuildArgs(contextDir: string, iidFile: string, project: string): string[] {
  if (!path.isAbsolute(contextDir) || !path.isAbsolute(iidFile)) throw new DockerError("absolute paths only");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(project)) throw new DockerError("bad project name");
  return ["build", "--build-arg", `BASE_IMAGE=${BASE_IMAGE}`, "--iidfile", iidFile, "--label", `factory.project=${project}`,
    "--file", path.join(contextDir, "agent.Dockerfile"), contextDir];
}

export async function buildAgentImage(docker: DockerCli, contextDir: string, workDir: string, project: string): Promise<string> {
  await baseImageId(docker);
  const iid = path.join(workDir, `agent-image-${project}.iid`);
  fs.rmSync(iid, { force: true });
  await docker.run(agentBuildArgs(contextDir, iid, project), { timeoutMs: 30 * 60_000 });
  const id = fs.readFileSync(iid, "utf8").trim();
  if (!ID_RE.test(id)) throw new DockerError("the build gave no image id");
  const doc = JSON.parse(await docker.out(["image", "inspect", id])) as unknown;
  const img = Array.isArray(doc) ? doc[0] : doc;
  if (!isObj(img) || !isObj(img.Config) || img.Config.User !== "1000:1000") throw new DockerError("the agent image doesn't run as the non-root user");
  return id;
}
