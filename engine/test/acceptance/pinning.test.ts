// Pinned owner keys (SR-5, AC-20): owner.*, allowed_repo_owners and enabled
// are pinned on first approval; any change, or a new listed path, stops the
// project until the owner confirms and the previously pinned owner approves.
import { afterEach, describe, expect, it } from "vitest";
import { drive } from "./support/clock";
import { World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function confirmExpectingFailure(world: World, asUserId: number) {
  const p = world.projects[0];
  let failed = false;
  try {
    const r = await world.engine!.confirmProject(p.configRepo);
    if (r.approval) world.gh.approve(r.approval.user_code, asUserId);
    await drive(world.clock, Promise.resolve(r.done), { maxMs: 1000 * 1000 });
  } catch {
    failed = true;
  }
  return failed;
}

describe("AC-20 / SR-5: a change to a pinned key stops the project", () => {
  it("[PIN-1] AC-20: a changed owner id stops the project and files a Security item; approval by the new id doesn't restart it; approval by the previously pinned owner does", async () => {
    w = await World.create();
    const p = w.projects[0];
    await w.boot();
    expect(await w.isRunning(p)).toBe(true);
    await w.stop();
    const before = w.securityItems().length;

    const newOwner = 3003;
    w.gh.addUser(newOwner, "new-owner");
    w.commitManifest(p, (t) => t.replace(/github_id: \d+/, `github_id: ${newOwner}`));
    await w.boot({ confirm: false });
    expect(await w.isRunning(p)).toBe(false);
    expect(w.securityItems().length).toBeGreaterThan(before);

    const failed = await confirmExpectingFailure(w, newOwner);
    expect(failed, "approval by the new owner id must not confirm the change").toBe(true);
    expect(await w.isRunning(p)).toBe(false);

    await w.confirm(p, p.ownerId);
    expect(await w.isRunning(p)).toBe(true);
  });

  it.each([
    ["the OAuth client id", (t: string) => t.replace(/oauth_client_id: \S+/, "oauth_client_id: Iv1.someoneelse")],
    ["the allow list", (t: string) => t.replace(/allowed_repo_owners:\n/, "allowed_repo_owners:\n  - { login: intruder, id: 6666 }\n")],
    ["enabled (false, then true again)", null],
  ])("[PIN-2] SR-5: a change to %s stops the project until the previous owner confirms", async (_n, edit) => {
    w = await World.create();
    const p = w.projects[0];
    await w.boot();
    await w.stop();
    const before = w.securityItems().length;
    if (edit) {
      w.commitManifest(p, edit);
    } else {
      w.commitManifest(p, (t) => t.replace("enabled: true", "enabled: false"));
      await w.boot({ confirm: false });
      expect(await w.isRunning(p)).toBe(false);
      await w.stop();
      w.commitManifest(p, (t) => t.replace("enabled: false", "enabled: true"));
    }
    await w.boot({ confirm: false });
    expect(await w.isRunning(p)).toBe(false);
    expect(w.securityItems().length).toBeGreaterThan(before);
    await w.confirm(p, p.ownerId);
    expect(await w.isRunning(p)).toBe(true);
  });

  it("[PIN-3] SR-5: a denied confirmation sign-in leaves the project stopped (fail closed)", async () => {
    w = await World.create();
    const p = w.projects[0];
    await w.boot();
    await w.stop();
    w.commitManifest(p, (t) => t.replace(/github_id: \d+/, "github_id: 3003"));
    await w.boot({ confirm: false });
    const r = await w.engine!.confirmProject(p.configRepo);
    expect(r.approval, "a pinned-key change needs a device sign-in").toBeDefined();
    w.gh.deny(r.approval!.user_code);
    await expect(drive(w.clock, Promise.resolve(r.done))).rejects.toBeDefined();
    expect(await w.isRunning(p)).toBe(false);
  });

  it("[PIN-4] SR-5: a new path in the projects file stops that project and files a Security item; the pinned project keeps running", async () => {
    w = await World.create([{ name: "old" }]);
    await w.boot();
    await w.stop();
    const before = w.securityItems().length;
    const added = w.addProject({ name: "new" });
    w.writeProjectsFile(w.projects.map((x) => x.configRepo));
    await w.boot({ confirm: false });
    expect(await w.isRunning(w.projects[0])).toBe(true);
    expect(await w.isRunning(added)).toBe(false);
    expect(w.securityItems().length).toBeGreaterThan(before);
  });

  it("[PIN-5] SR-5: an unchanged manifest after restart needs no confirmation (control for PIN-1)", async () => {
    w = await World.create();
    await w.boot();
    await w.restart();
    expect(await w.isRunning(w.projects[0])).toBe(true);
  });
});
