import { realPath } from "../fsutil";
import * as fs from "node:fs";
import { Clock, iso } from "../clock";
import { Git } from "../git";
import { GitHubClient, startDeviceApproval } from "../github";
import { Logger } from "../log";
import { readManifest, type InterviewSignIn } from "./manifest";
import { ConfigError, checkProjectPath, readPathsFile } from "./paths-file";
import { PinStore, comparePin, pinnedKeys } from "./pins";
import type { OsApi } from "../os/ffi";

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
  const listed = readPathsFile(o.masterRepo, o.os);
  const want = realPath(o.projectPath);
  const match = listed.find((p) => {
    try {
      return realPath(p) === want;
    } catch {
      return false;
    }
  });
  if (!match) throw new ConfigError("That path isn't in factory-projects.local.yaml.");
  const real = await checkProjectPath(match, o.masterRepo, o.git);
  const m = await readManifest(o.git, real);
  const pin = o.pins.get(real);
  const cmp = comparePin(pin, m);
  if (cmp.status === "match") {
    o.io.say("Nothing to confirm: the pinned keys match main.");
    return true;
  }
  const now = pinnedKeys(m);
  o.io.say(cmp.status === "new_path" ? `New project path: ${real}` : `Changed keys: ${cmp.keys.join(", ")}`);
  o.io.say(`Manifest on main at ${m.commit}:`);
  const signIn = (v: InterviewSignIn | null | undefined) => (v ? JSON.stringify(v) : "level default");
  if (pin) o.io.say(`  pinned:  owner ${JSON.stringify(pin.owner)}, allowed_repo_owners ${JSON.stringify(pin.allowed_repo_owners)}, enabled ${pin.enabled}, interview sign-in ${signIn(pin.interview_sign_in)}`);
  o.io.say(`  on main: owner ${JSON.stringify(now.owner)}, allowed_repo_owners ${JSON.stringify(now.allowed_repo_owners)}, enabled ${now.enabled}, interview sign-in ${signIn(now.interview_sign_in)}`);
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
  o.pins.set(real, { ...now, pinned_at: iso(o.clock.now()), commit: m.commit });
  o.log.action({ agent: "owner", action: "pins.confirm", target: m.name, approval_id: `confirm:${m.name}`, outcome: "pinned" });
  o.io.say("Confirmed and pinned. Restart the engine to run the project.");
  return true;
}
