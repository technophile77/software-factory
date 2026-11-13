import { DockerCli, DockerError } from "./cli";

/**
 * The LiteLLM router image (F-013, ADR 0019, SR-16, SR-17): the project's
 * non-root build, which holds the endpoint API keys. Adopting a newer release
 * is a hygiene item under SR-17 (14-day quarantine, LTS line, conformance run);
 * this pin is the A-1 spike's, 1.109.1, not a standing adoption.
 */
export const LITELLM_IMAGE = "ghcr.io/berriai/litellm-non_root";
/** The multi-arch index digest of LiteLLM 1.109.1. A tag could be moved after a compromise; a digest can't. */
export const LITELLM_IMAGE_DIGEST = "sha256:e9e15fe17b66fc8cda6ff7e18914e1d452785ca404fa20336ec447152f86daba";
export const LITELLM_IMAGE_REF = `${LITELLM_IMAGE}@${LITELLM_IMAGE_DIGEST}`;
/** Set to the pinned digest to say the cosign signature was verified by hand; any other value counts for nothing. */
export const LITELLM_SIGNATURE_ENV = "FACTORY_LITELLM_SIGNATURE_VERIFIED";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID_RE = /^sha256:[0-9a-f]{64}$/;

export interface LitellmSignatureCheck {
  /** The owner or CI verified the cosign signature of the pinned digest out of band. */
  verifiedOutOfBand?: boolean;
  /** The process environment to look in; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Hook for the cosign check of the pinned digest against the key at a pinned
 * LiteLLM commit (litellm review, condition 1). Cosign isn't bundled with the
 * engine yet, so nothing is verified here: this refuses unless the caller says
 * the check was done out of band, either with `verifiedOutOfBand` or with
 * `FACTORY_LITELLM_SIGNATURE_VERIFIED` set to the pinned digest (so a claim
 * made for an older pin doesn't carry over). Replace the body with a real
 * `cosign verify` when cosign ships with the engine.
 *
 * @example
 * verifyLitellmSignature({ verifiedOutOfBand: true }); // returns
 * @throws DockerError when no out-of-band verification is claimed.
 */
export function verifyLitellmSignature(o: LitellmSignatureCheck = {}): void {
  const env = o.env ?? process.env;
  if (o.verifiedOutOfBand === true || env[LITELLM_SIGNATURE_ENV] === LITELLM_IMAGE_DIGEST) return;
  throw new DockerError(`the LiteLLM image's cosign signature hasn't been verified and the engine can't verify it yet; verify ${LITELLM_IMAGE_DIGEST} with cosign, then set ${LITELLM_SIGNATURE_ENV} to that digest`);
}

/** The pinned LiteLLM image as the router container needs it: by id, with the numeric user it runs as. */
export interface LitellmImage {
  id: string;
  /** `uid:gid` from the image's own `Config.User` (a bare uid is paired with the same gid); never root. */
  user: string;
}

/**
 * The local id and run-as user of the pinned LiteLLM image, pulling it by
 * digest if needed. The signature hook runs first, so an unverified image is
 * never pulled; an image without the pinned digest, or whose user isn't a
 * numeric non-root `uid:gid`, is refused.
 *
 * @param docker the local docker client.
 * @example
 * const { id, user } = await litellmImageId(docker, { signature: { verifiedOutOfBand: true } });
 * // id "sha256:...", user "65532:65532"
 * @throws DockerError when unverified, wrongly pinned, or not run as a numeric non-root user.
 * @see baseImageId
 */
export async function litellmImageId(docker: DockerCli, o: { signature?: LitellmSignatureCheck } = {}): Promise<LitellmImage> {
  verifyLitellmSignature(o.signature);
  const have = await docker.run(["image", "inspect", LITELLM_IMAGE_REF], { okCodes: [1] });
  // The first start has nothing local, and the image is large: allow for a slow pull.
  if (have.code !== 0) await docker.run(["pull", LITELLM_IMAGE_REF], { timeoutMs: 30 * 60_000 });
  const doc = JSON.parse(await docker.out(["image", "inspect", LITELLM_IMAGE_REF])) as unknown;
  const img = Array.isArray(doc) ? doc[0] : doc;
  if (!isObj(img) || typeof img.Id !== "string" || !ID_RE.test(img.Id)) throw new DockerError("the LiteLLM image has no id");
  const digests = Array.isArray(img.RepoDigests) ? img.RepoDigests.map(String) : [];
  if (!digests.some((d) => d.endsWith(`@${LITELLM_IMAGE_DIGEST}`))) throw new DockerError("the LiteLLM image doesn't carry the pinned digest");
  const reported = isObj(img.Config) && typeof img.Config.User === "string" ? img.Config.User : "";
  // The real image reports a bare uid ("65534", nobody, whose group is also 65534); a run needs both numbers.
  const user = /^[1-9][0-9]{0,9}$/.test(reported) ? `${reported}:${reported}` : reported;
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(user)) throw new DockerError("the LiteLLM image doesn't run as a numeric non-root uid:gid");
  return { id: img.Id, user };
}
