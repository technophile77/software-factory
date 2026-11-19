import { realPath } from "../fsutil";
import * as fs from "node:fs";
import { Clock, iso } from "../clock";
import { Git } from "../git";
import { GitHubClient, startDeviceApproval } from "../github";
import { Logger } from "../log";
import { readManifest, type InterviewSignIn } from "./manifest";
import { ConfigError, checkProjectPath, readPathsFile } from "./paths-file";
import { readProjectFiles, sameRepoUrl } from "./project-files";
import * as path from "node:path";
import { PinStore, comparePin, pinnedKeys } from "./pins";
import type { OsApi } from "../os/ffi";

/**
 * F-023 FR-5: `--project` takes a project name (its file in projects/) or a
 * config repo path named by one. Before the one-time import, the old paths
 * file is read instead. Gives the path as listed, and the file's name and
 * URL when a project file named it.
 */
export function findProject(master: string, given: string, os: OsApi): { path: string; name: string | null; url: string | null } {
  const entries = readProjectFiles(master, os);
  if (!entries.length && fs.existsSync(path.join(master, "factory-projects.local.yaml"))) {
    const want = realPath(path.resolve(given));
    const hit = readPathsFile(master, os).find((p) => {
      try {
        return realPath(p) === want;
      } catch {
        return false;
      }
    });
    if (!hit) throw new ConfigError("That path isn't in factory-projects.local.yaml.");
    return { path: hit, name: null, url: null };
  }
  const byName = entries.find((e) => e.file === `${given}.yaml`);
  if (byName) {
    if (!byName.project) throw new ConfigError(byName.error ?? "That project file was refused.");
    return { ...byName.project };
  }
  let want: string | null = null;
  try {
    want = realPath(path.resolve(given));
  } catch {
    // Neither a project name nor an existing path.
  }
  const byPath = want && entries.find((e) => {
    try {
      return !!e.project && realPath(e.project.path) === want;
    } catch {
      return false;
    }
  });
  if (!byPath || !byPath.project) throw new ConfigError(`No project file in projects/ is named ${given} or names that config repo.`);
  return { ...byPath.project };
}

/** The config repo's factory/state: the local branch, or origin's after a fresh clone; null when there is none. */
async function factoryStateHead(git: Git, repo: string): Promise<string | null> {
  for (const ref of ["refs/heads/factory/state", "refs/remotes/origin/factory/state"]) {
    const sha = await git.revParse(repo, ref).catch(() => null);
    if (sha) return sha;
  }
  return null;
}

export interface ConfirmIo {
  say(line: string): void;
  ask(question: string): Promise<string>;
}

/**
 * The engine command that accepts a change to a project's pinned keys, or a
 * new project path (SR-5). The owner sees exactly what changed, types the
 * project's name, and then approves a GitHub device sign-in as the
 * *previously* pinned owner (the manifest's owner only for a first pin).
 * Nothing is pinned unless all of that succeeds.
 */
export async function confirmProject(o: {
  masterRepo: string;
  projectPath: string;
  git: Git;
  github: GitHubClient;
  pins: PinStore;
  os: OsApi;
  clock: Clock;
  log: Logger;
  io: ConfirmIo;
}): Promise<boolean> {
  const found = findProject(o.masterRepo, o.projectPath, o.os);
  const real = await checkProjectPath(found.path, o.masterRepo, o.git);
  const m = await readManifest(o.git, real);
  if (found.name && found.name !== m.name) throw new ConfigError(`The project file names the project ${found.name}, but the manifest on main names it ${m.name}.`);
  // F-023 FR-8: pins are kept by name; one still under the path is moved first.
  o.pins.moveToName([...new Set([real, found.path])], m.name, found.url);
  const pin0 = o.pins.get(m.name);
  // A pin for another config repo under the same name doesn't carry over.
  const pin = pin0?.url && found.url && !sameRepoUrl(pin0.url, found.url) ? null : pin0;
  const cmp = comparePin(pin, m);
  if (cmp.status === "match") {
    o.io.say("Nothing to confirm: the pinned keys match main.");
    return true;
  }
  const now = pinnedKeys(m);
  o.io.say(cmp.status === "new_path" ? `New project path: ${real}` : `Changed keys: ${cmp.keys.join(", ")}`);
  o.io.say(`Manifest on main at ${m.commit}:`);
  const signIn = (v: InterviewSignIn | null | undefined) => (v ? JSON.stringify(v) : "level default");
  if (pin) o.io.say(`  pinned:  owner ${JSON.stringify(pin.owner)}, allowed_repo_owners ${JSON.stringify(pin.allowed_repo_owners)}, enabled ${pin.enabled}, interview sign-in ${signIn(pin.interview_sign_in)}, repo visibility ${JSON.stringify(pin.repo_visibility ?? {})}`);
  o.io.say(`  on main: owner ${JSON.stringify(now.owner)}, allowed_repo_owners ${JSON.stringify(now.allowed_repo_owners)}, enabled ${now.enabled}, interview sign-in ${signIn(now.interview_sign_in)}, repo visibility ${JSON.stringify(now.repo_visibility)}`);
  if (!pin) {
    const head = await factoryStateHead(o.git, real);
    o.io.say(head
      ? `factory/state is at ${head}: its interviews are taken as written by a factory, and anything added to it later only if this factory wrote it (F-023 FR-8).`
      : "factory/state doesn't exist yet; this factory starts it.");
  }
  const typed = (await o.io.ask(`If you made this change, type the project name (${m.name}) to confirm: `)).trim();
  if (typed !== m.name) {
    o.io.say("Not confirmed; nothing changed.");
    return false;
  }
  const approver = pin?.owner ?? m.owner;
  const ac = new AbortController();
  const pending = await startDeviceApproval({
    github: o.github, clientId: approver.oauth_client_id, ownerId: approver.github_id, clock: o.clock,
    signal: ac.signal, log: o.log, approvalId: `confirm:${m.name}`,
  });
  o.io.say(`On your phone, open ${pending.verificationUri} and enter ${pending.userCode}, signed in as GitHub account id ${approver.github_id}. The code expires at ${pending.expiresAt}.`);
  const result = await pending.result;
  if (!result.approved) {
    o.io.say(`Not approved (${result.reason}); nothing changed.`);
    return false;
  }
  // F-023 FR-8: the first confirm on this factory also fixes the factory/state this factory trusts as written by a factory.
  const stateCommit = pin ? (pin.state_commit ?? null) : await factoryStateHead(o.git, real);
  o.pins.set(m.name, { ...now, pinned_at: iso(o.clock.now()), commit: m.commit, url: found.url ?? pin?.url, state_commit: stateCommit });
  o.log.action({ agent: "owner", action: "pins.confirm", target: m.name, approval_id: `confirm:${m.name}`, outcome: "pinned" });
  o.io.say("Confirmed and pinned. A running engine starts the project within a few seconds; otherwise start the engine.");
  return true;
}
