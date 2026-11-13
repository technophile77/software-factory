import { DockerCli, DockerError } from "./cli";

/** The LiteLLM router image's repository (F-013, ADR 0019, SR-16): the project's non-root build, which holds the endpoint API keys. */
export const LITELLM_IMAGE = "ghcr.io/berriai/litellm-non_root";

/** A release the factory may run: its version, the multi-arch index digest (a tag can be moved after a compromise; a digest can't) and when it was published. */
export interface LitellmPin {
  version: string;
  digest: string;
  /** ISO 8601 time the release was published; the 14-day quarantine counts from it. */
  publishedAt: string;
  /**
   * Why a release off the LTS line is allowed: a record of the owner's decision
   * (id and date). Absent for an LTS release. Only a non-empty text lifts the
   * line rule; the 14-day quarantine still applies.
   */
  exception?: string;
}

/** The only release line the factory runs unless a pin carries an owner exception (OQ-12 (a), SR-17). */
export const LITELLM_LTS_LINE = "1.108";
/** Days a release must have been public before the factory may run it (SR-17). */
export const LITELLM_QUARANTINE_DAYS = 14;

/**
 * The LiteLLM release the factory runs, or null while none is approved.
 *
 * SR-17 rule (owner decision OQ-12 (a)): the factory runs only a 1.108.x LTS
 * release that is at least 14 days old. The owner then changed OQ-12 on
 * 13 Nov 2026 and approved 1.106.4 now, as a recorded exception to the LTS
 * line (no 1.108.x release was 14 days old yet); the quarantine still holds.
 * A hygiene item changes the pin, on one line in the form
 * `{ version: "1.108.N", digest: "sha256:...", publishedAt: "2026-.." }` (plus
 * `exception: "..."` for a release off the LTS line); `litellmPinProblem` and
 * CI both refuse a pin that breaks the rule, and the CI image scan reads the
 * digest from this line, so it must stay on one line.
 */
export const LITELLM_PIN: LitellmPin | null = { version: "1.106.4", digest: "sha256:ee5cb38e33c8be6d6774f7db922396b6b04d1cd962e77521b6c892b8f1c70fd8", publishedAt: "2026-10-25T09:39:15Z", exception: "OQ-12: owner pinned non-LTS 1.106.4, 2026-11-13" };

/** The pinned image by digest. @throws DockerError when `pin` is null. */
export function litellmImageRef(pin: LitellmPin | null): string {
  if (!pin) throw new NoLitellmPinError();
  return `${LITELLM_IMAGE}@${pin.digest}`;
}

/** Thrown when no approved LiteLLM release is pinned; its message is the plain reason an endpoint rung shows. */
export class NoLitellmPinError extends DockerError {
  constructor() {
    super("no approved LiteLLM release pinned yet (SR-17)");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID_RE = /^sha256:[0-9a-f]{64}$/;
const LTS_VERSION_RE = new RegExp(`^${LITELLM_LTS_LINE.replace(".", "\\.")}\\.(0|[1-9][0-9]*)$`);
const DAY_MS = 86_400_000;

/**
 * Why a pin breaks the SR-17 rule, or null when it is acceptable: the version
 * must be on the 1.108.x LTS line unless the pin carries a non-empty
 * `exception`, the digest well formed, and `publishedAt` at least 14 days
 * before `nowMs` (a future or unreadable date fails, exception or not).
 *
 * @param nowMs the current time in epoch milliseconds, injected so the rule is testable.
 * @example
 * litellmPinProblem({ version: "1.108.2", digest: `sha256:${"a".repeat(64)}`, publishedAt: "2026-11-01T00:00:00Z" }, Date.parse("2026-11-20T00:00:00Z")); // null
 * litellmPinProblem({ version: "1.109.1", digest: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-01T00:00:00Z" }, Date.parse("2026-11-20T00:00:00Z")); // "version 1.109.1 isn't on the 1.108.x LTS line and has no owner exception"
 * litellmPinProblem({ version: "1.106.4", digest: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-25T09:39:15Z", exception: "OQ-12" }, Date.parse("2026-11-20T00:00:00Z")); // null
 */
export function litellmPinProblem(pin: LitellmPin, nowMs: number): string | null {
  const excepted = typeof pin.exception === "string" && pin.exception.trim() !== "";
  if (!excepted && !LTS_VERSION_RE.test(pin.version)) return `version ${pin.version} isn't on the ${LITELLM_LTS_LINE}.x LTS line and has no owner exception`;
  if (!ID_RE.test(pin.digest)) return "the digest isn't a sha256 image digest";
  const published = Date.parse(pin.publishedAt);
  if (!Number.isFinite(published)) return "the publication date isn't readable";
  if (nowMs - published < LITELLM_QUARANTINE_DAYS * DAY_MS) return `version ${pin.version} was published less than ${LITELLM_QUARANTINE_DAYS} days ago`;
  return null;
}

/** The pinned LiteLLM image as the router container needs it: by id, with the numeric user it runs as. */
export interface LitellmImage {
  id: string;
  /** `uid:gid` from the image's own `Config.User` (a bare uid is paired with the same gid); never root. */
  user: string;
}

/**
 * The local id and run-as user of the pinned LiteLLM image, pulling it by
 * digest if needed. The pin rule (`litellmPinProblem`) and the cosign check
 * (`verify`, see `makeCosignVerifier`) run first, so an unapproved or
 * unverified image is never pulled; an image without the pinned digest, or
 * whose user isn't a numeric non-root `uid:gid`, is refused. Nothing in the
 * environment counts as proof of a signature.
 *
 * @param docker the local docker client.
 * @param o.verify throws unless the image reference carries a valid signature.
 * @param o.pin the release to run; defaults to `LITELLM_PIN` (tests pass their own).
 * @param o.now the clock in epoch milliseconds for the 14-day rule; defaults to `Date.now`.
 * @example
 * const { id, user } = await litellmImageId(docker, { verify: makeCosignVerifier(cosignOptions) });
 * // id "sha256:...", user "65532:65532"
 * @throws NoLitellmPinError when no release is pinned; DockerError when the pin breaks SR-17, the signature is refused, the digest is wrong, or the user isn't numeric non-root.
 * @see baseImageId
 */
export async function litellmImageId(docker: DockerCli, o: { verify: (imageRef: string) => Promise<void>; pin?: LitellmPin | null; now?: () => number }): Promise<LitellmImage> {
  const pin = o.pin === undefined ? LITELLM_PIN : o.pin;
  if (!pin) throw new NoLitellmPinError();
  const problem = litellmPinProblem(pin, (o.now ?? Date.now)());
  if (problem) throw new DockerError(`the pinned LiteLLM release is refused: ${problem}`);
  const ref = litellmImageRef(pin);
  await o.verify(ref);
  const have = await docker.run(["image", "inspect", ref], { okCodes: [1] });
  // The first start has nothing local, and the image is large: allow for a slow pull.
  if (have.code !== 0) await docker.run(["pull", ref], { timeoutMs: 30 * 60_000 });
  const doc = JSON.parse(await docker.out(["image", "inspect", ref])) as unknown;
  const img = Array.isArray(doc) ? doc[0] : doc;
  if (!isObj(img) || typeof img.Id !== "string" || !ID_RE.test(img.Id)) throw new DockerError("the LiteLLM image has no id");
  const digests = Array.isArray(img.RepoDigests) ? img.RepoDigests.map(String) : [];
  if (!digests.some((d) => d.endsWith(`@${pin.digest}`))) throw new DockerError("the LiteLLM image doesn't carry the pinned digest");
  const reported = isObj(img.Config) && typeof img.Config.User === "string" ? img.Config.User : "";
  // The real image reports a bare uid ("65534", nobody, whose group is also 65534); a run needs both numbers.
  const user = /^[1-9][0-9]{0,9}$/.test(reported) ? `${reported}:${reported}` : reported;
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(user)) throw new DockerError("the LiteLLM image doesn't run as a numeric non-root uid:gid");
  return { id: img.Id, user };
}
