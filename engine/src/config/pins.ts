import * as fs from "node:fs";
import * as path from "node:path";
import { canonical } from "../state/transcript";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";
import type { InterviewSignIn, Manifest, RepoOwner, RepoVisibility } from "./manifest";

/**
 * The pinned security keys of each project (SR-5): `owner.*`,
 * `allowed_repo_owners`, `enabled`, `settings.interview_sign_in` (F-018
 * FR-15) and each repo's `visibility` (F-015 SR-6, H-0249), keyed by the
 * project's name (F-023 FR-8; pins made before were keyed by the config
 * repo's real path and move to the name the first time the engine sees it).
 * Kept in an engine-only file outside every repo; only the confirm command
 * writes it, after the owner's confirmation and a device approval by the
 * previously pinned owner. Increment 3 replaces this with signed owner actions.
 */
export interface Pin {
  name: string;
  owner: { github_id: number; oauth_client_id: string };
  allowed_repo_owners: RepoOwner[];
  enabled: boolean;
  /** F-018 FR-15; absent in pins made before it, which matches a manifest without the key. */
  interview_sign_in?: InterviewSignIn | null;
  /** H-0249: repo name to recorded visibility; absent in older pins, which matches a manifest with none recorded. */
  repo_visibility?: Record<string, RepoVisibility>;
  pinned_at: string;
  /** The manifest commit the owner confirmed. */
  commit: string;
  /** F-023 FR-8: the config repo the owner confirmed; a project file naming another one needs a new confirm. */
  url?: string;
  /**
   * F-023 FR-8: factory/state as it stood when the owner first confirmed the project on this factory. Transcripts
   * this factory has no chain record of are trusted as they were at this commit, never as anything later.
   */
  state_commit?: string | null;
}

export type PinCheck =
  | { status: "match" }
  | { status: "new_path" }
  | { status: "changed"; keys: string[] };

export function pinnedKeys(m: Pick<Manifest, "owner" | "allowed_repo_owners" | "enabled" | "name" | "interviewSignIn" | "repos">) {
  const repoVisibility = Object.fromEntries(m.repos.filter((r) => r.visibility).map((r) => [r.name, r.visibility!]).sort(([a], [b]) => (a! < b! ? -1 : 1)));
  return { name: m.name, owner: m.owner, allowed_repo_owners: m.allowed_repo_owners, enabled: m.enabled, interview_sign_in: m.interviewSignIn, repo_visibility: repoVisibility };
}

export function comparePin(pin: Pin | null, m: Manifest): PinCheck {
  if (!pin) return { status: "new_path" };
  const now = pinnedKeys(m);
  const keys: string[] = [];
  if (canonical(pin.owner) !== canonical(now.owner)) keys.push("owner");
  if (canonical(pin.allowed_repo_owners) !== canonical(now.allowed_repo_owners)) keys.push("allowed_repo_owners");
  if (pin.enabled !== now.enabled) keys.push("enabled");
  // An agent with write access to the config repo must not be able to loosen sign-in unseen.
  if (canonical(pin.interview_sign_in ?? null) !== canonical(now.interview_sign_in)) keys.push("settings.interview_sign_in");
  // Publishing code to a public repo is the owner's own confirmation (SR-6), so an agent can't add it.
  if (canonical(pin.repo_visibility ?? {}) !== canonical(now.repo_visibility)) keys.push("repos[].visibility");
  return keys.length ? { status: "changed", keys } : { status: "match" };
}

interface Data {
  version: 1;
  projects: Record<string, Pin>;
}

export class PinStore {
  private readonly file: string;

  constructor(dir: string) {
    ensureOwnerDir(dir);
    this.file = path.join(dir, "pins.json");
  }

  private load(): Data {
    if (!fs.existsSync(this.file)) return { version: 1, projects: {} };
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Data>;
    if (raw.version !== 1 || !raw.projects || typeof raw.projects !== "object") {
      throw new Error("The pinned-keys record is unreadable; refusing to guess.");
    }
    return raw as Data;
  }

  get(projectPath: string): Pin | null {
    return this.load().projects[projectPath] ?? null;
  }

  set(projectPath: string, pin: Pin): void {
    const d = this.load();
    d.projects[projectPath] = pin;
    writeFileAtomic(this.file, JSON.stringify(d, null, 2));
  }

  /** F-023 FR-8: moves a pin made under the config repo's path to the project's name, unless the name already has one. */
  moveToName(paths: readonly string[], name: string, url: string | null): void {
    const d = this.load();
    const from = paths.find((p) => d.projects[p]);
    if (!from) return;
    if (!d.projects[name]) d.projects[name] = { ...d.projects[from]!, ...(url ? { url } : {}) };
    for (const p of paths) delete d.projects[p];
    writeFileAtomic(this.file, JSON.stringify(d, null, 2));
  }
}
