import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  LIMITS_FILE, Limits, LimitsError, agentLimits, containerLimits, manifestLimits, maxPageBytes, mergeLimits, parseLimits,
  readDefaultLimits, roleContainerLimits, sessionCaps, worktreeLimits,
} from "../src/config/limits";
import { Git } from "../src/git";
import { Children } from "../src/proc";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";

const MiB = 1024 * 1024;
const SHIPPED = fs.readFileSync(path.join(__dirname, "..", "config", "limits.yaml"), "utf8");
const defaults = (): Limits => parseLimits(YAML.parse(SHIPPED), LIMITS_FILE, true);
const testGit = () => new Git({ gitPath: GIT_PATH, homeDir: tmpdir(), children: new Children() });

describe("engine/config/limits.yaml (H-0087)", () => {
  it("ships exactly the approved values", () => {
    expect(defaults()).toEqual({
      analyst: { turns: 300, output_tokens: 500000, dollars: 15, wall_time_minutes: 240, cpus: 2, memory_mib: 2048, pids: 256, tmp_mib: 512 },
      web_reader: { turns: 30, output_tokens: 60000, dollars: 1, wall_time_minutes: 10, cpus: 1, memory_mib: 1024, pids: 128, tmp_mib: 256 },
      proxy: { cpus: 0.5, memory_mib: 256, pids: 64, tmp_mib: 16 },
      research_web: { per_question: 3, per_session: 20 },
      fetch_page: { max_download_mib: 2, max_chars: 50000 },
      research_result: { summary_chars: 2000, max_sources: 8 },
      worktree_commit: { max_files: 200, max_total_mib: 5, max_file_mib: 1 },
    });
  });
});

describe("parseLimits", () => {
  const full = () => YAML.parse(SHIPPED) as Record<string, Record<string, unknown>>;
  it.each([
    ["an unknown section", (d: Record<string, Record<string, unknown>>) => (d.extra = { a: 1 }), /unknown section 'extra'/],
    ["an unknown key", (d: Record<string, Record<string, unknown>>) => (d.proxy!.turns = 1), /unknown key 'proxy.turns'/],
    ["zero", (d: Record<string, Record<string, unknown>>) => (d.analyst!.turns = 0), /'analyst.turns' must be a positive number/],
    ["a negative number", (d: Record<string, Record<string, unknown>>) => (d.proxy!.cpus = -1), /'proxy.cpus'/],
    ["a string", (d: Record<string, Record<string, unknown>>) => (d.analyst!.dollars = "15"), /'analyst.dollars'/],
    ["a fraction where a whole number is needed", (d: Record<string, Record<string, unknown>>) => (d.analyst!.pids = 1.5), /whole number/],
    ["a missing key", (d: Record<string, Record<string, unknown>>) => delete d.fetch_page!.max_chars, /'fetch_page.max_chars' is missing/],
    ["a missing section", (d: Record<string, Record<string, unknown>>) => delete d.worktree_commit, /'worktree_commit' is missing/],
    ["a section that isn't a mapping", (d: Record<string, Record<string, unknown>>) => ((d as Record<string, unknown>).proxy = [1]), /'proxy' must be a mapping/],
  ])("refuses %s", (_name, mutate, re) => {
    const d = full();
    mutate(d);
    expect(() => parseLimits(d, LIMITS_FILE, true)).toThrow(re);
    expect(() => parseLimits(d, LIMITS_FILE, true)).toThrow(LimitsError);
  });

  it("takes a subset from a manifest, and fractions where the key allows them", () => {
    expect(parseLimits({ proxy: { cpus: 0.25 }, worktree_commit: { max_file_mib: 0.5 } }, "m", false)).toEqual({ proxy: { cpus: 0.25 }, worktree_commit: { max_file_mib: 0.5 } });
    expect(() => parseLimits({ analyst: { turns: 2.5 } }, "m", false)).toThrow(/whole number/);
    expect(() => parseLimits("x", "m", false)).toThrow(/mapping/);
  });

  it("manifestLimits: none without the key; checked when present", () => {
    expect(manifestLimits({ name: "acme" })).toBeNull();
    expect(manifestLimits({ limits: { research_web: { per_question: 2 } } })).toEqual({ research_web: { per_question: 2 } });
    expect(() => manifestLimits({ limits: null })).toThrow(/factory-project.yaml limits: must be a mapping/);
  });
});

describe("mergeLimits", () => {
  it("takes the lower value per key and lists every key above the default", () => {
    const d = defaults();
    const { limits, above } = mergeLimits(d, { analyst: { turns: 10, pids: 256 }, proxy: { memory_mib: 512 }, fetch_page: { max_chars: 50001 } });
    expect(limits.analyst.turns).toBe(10);
    expect(limits.analyst.pids).toBe(256);
    // A refused key keeps its default, so nothing above it is ever used.
    expect(limits.proxy.memory_mib).toBe(256);
    expect(above).toEqual(["proxy.memory_mib", "fetch_page.max_chars"]);
    expect(d.analyst.turns).toBe(300);
    expect(mergeLimits(d, null)).toEqual({ limits: d, above: [] });
  });
});

describe("readDefaultLimits", () => {
  it("reads the file at the commit it is given, not the working tree, and fails closed when missing or invalid", async () => {
    const repo = tmpdir();
    initRepo(repo, { "README.md": "m\n" });
    const read = () => readDefaultLimits(testGit(), repo, git(repo, "rev-parse", "HEAD"));
    await expect(read()).rejects.toThrow(/missing/);
    fs.mkdirSync(path.join(repo, "engine", "config"), { recursive: true });
    fs.writeFileSync(path.join(repo, LIMITS_FILE), SHIPPED);
    await expect(read()).rejects.toThrow(LimitsError);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "limits");
    const good = git(repo, "rev-parse", "HEAD");
    expect(await read()).toEqual(defaults());
    fs.writeFileSync(path.join(repo, LIMITS_FILE), "analyst: [");
    git(repo, "commit", "-qam", "broken");
    await expect(read()).rejects.toThrow(/not valid YAML/);
    // The pinned commit still reads as it was, whatever came after it.
    expect(await readDefaultLimits(testGit(), repo, good)).toEqual(defaults());
    fs.writeFileSync(path.join(repo, LIMITS_FILE), SHIPPED.replace("max_sources: 8", "max_sources: 8\n  extra: 1"));
    git(repo, "commit", "-qam", "extra key");
    await expect(read()).rejects.toThrow(/unknown key 'research_result.extra'/);
  });
});

describe("consumers", () => {
  const l = defaults();

  it("SR-18 session caps: dollars only in tokens (API key) mode", () => {
    expect(sessionCaps(l.analyst, "tokens")).toEqual({ maxTurns: 300, maxOutputTokens: 500000, maxBudgetUsd: 15, wallTimeMs: 4 * 3600_000 });
    expect(sessionCaps(l.web_reader, "subscription")).toEqual({ maxTurns: 30, maxOutputTokens: 60000, wallTimeMs: 10 * 60_000 });
  });

  it("container plans: analyst, web reader and proxy", () => {
    expect(roleContainerLimits(l)).toEqual({
      "requirements-analyst": { cpus: 2, memoryBytes: 2048 * MiB, pids: 256, tmpBytes: 512 * MiB },
      "web-reader": { cpus: 1, memoryBytes: 1024 * MiB, pids: 128, tmpBytes: 256 * MiB },
    });
    expect(containerLimits(l.proxy)).toEqual({ cpus: 0.5, memoryBytes: 256 * MiB, pids: 64, tmpBytes: 16 * MiB });
  });

  it("research_web, fetch_page, summary and sources", () => {
    expect(agentLimits(l, "tokens")).toMatchObject({
      research: { perQuestion: 3, perSession: 20 }, page: { maxChars: 50000 }, summaryMaxChars: 2000, maxSources: 8,
      analyst: { maxTurns: 300 }, reader: { maxTurns: 30, maxBudgetUsd: 1 },
    });
    expect(maxPageBytes(l)).toBe(2 * MiB);
  });

  it("worktree commit, with a lowered fraction floored to whole bytes", () => {
    expect(worktreeLimits(l)).toEqual({ maxFiles: 200, maxTotalBytes: 5 * MiB, maxFileBytes: MiB });
    const lowered = mergeLimits(l, { worktree_commit: { max_file_mib: 0.3 } }).limits;
    expect(worktreeLimits(lowered).maxFileBytes).toBe(Math.floor(0.3 * MiB));
  });
});
