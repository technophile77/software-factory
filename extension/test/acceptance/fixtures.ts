// Fixtures built from the Inbox item v1.0 contract (docs/interface-contracts.md),
// not from the implementation, so the tests stay independent of it.
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { InboxItem, RepoRoot, GitRunner } from "../../src/core/types";

export const DECISION_BODY = [
  "## Context",
  "We need a session store for login.",
  "",
  "## Options",
  "### A: Redis",
  "- Pro: fast lookups",
  "- Con: another service to run",
  "",
  "### B: Postgres table",
  "- Pro: no new infrastructure",
  "- Con: slower under load",
  "",
  "## Project impact",
  "Affects F-012 login only.",
  "",
  "## Recommendation",
  "Option A, because latency matters most.",
  "",
  "## Cost of delay",
  "Blocks F-012 build stage.",
  "",
].join("\n");

export type Frontmatter = Record<string, unknown>;

export function frontmatter(overrides: Frontmatter = {}): Frontmatter {
  const priority = (overrides.priority as string | undefined) ?? "high";
  const fm: Frontmatter = {
    schema: "inbox-item/1.0",
    id: "D-0001",
    inbox: "decision",
    title: "Choose session store for login",
    category: "Architecture",
    priority,
    effective_priority: priority,
    blocking: false,
    status: "open",
    feature: "F-012",
    created_by: "orchestrator",
    created_at: "2026-11-08T21:00:00Z",
    options: [
      { id: "A", label: "Redis" },
      { id: "B", label: "Postgres table" },
    ],
    recommendation: "A",
    links: [{ kind: "file", ref: "docs/features/F-012-login.md" }],
    history: [{ at: "2026-11-08T21:00:00Z", by: "orchestrator", action: "filed" }],
    ...overrides,
  };
  // A key overridden with undefined means "leave this field out".
  for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
  return fm;
}

/** A complete item file (YAML frontmatter + Markdown body) as an agent would write it. */
export function itemFile(overrides: Frontmatter = {}, body: string = DECISION_BODY): string {
  return `---\n${stringify(frontmatter(overrides))}---\n${body}`;
}

/** The same item as the in-memory InboxItem shape from types.ts. */
export function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const fm = frontmatter(overrides as Frontmatter) as unknown as InboxItem;
  return { ...fm, body: DECISION_BODY, extra: {}, ...overrides } as InboxItem;
}

export interface TempRepo extends RepoRoot {
  decisionDir: string;
  cleanup(): Promise<void>;
}

/** A repo folder with `.factory/inbox/decision/` (unless withFactory is false). */
export async function makeRepo(name: string, withFactory = true): Promise<TempRepo> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sf-acc-")));
  const repoDir = join(base, name);
  const factoryDir = join(repoDir, ".factory");
  const decisionDir = join(factoryDir, "inbox", "decision");
  await mkdir(withFactory ? decisionDir : repoDir, { recursive: true });
  return {
    name,
    repoDir,
    factoryDir,
    decisionDir,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export async function writeItem(repo: TempRepo, fileName: string, text: string): Promise<string> {
  const p = join(repo.decisionDir, fileName);
  await writeFile(p, text, "utf8");
  return p;
}

export interface GitCall {
  cwd: string;
  args: string[];
}

export function fakeGit(): { git: GitRunner; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const git: GitRunner = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
  };
  return { git, calls };
}

/** The git subcommand, skipping global options such as `-c k=v` or `-C dir`. */
export function subcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c" || a === "-C") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

export function commitMessage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-m" || a === "--message") return args[i + 1];
    if (a.startsWith("--message=")) return a.slice("--message=".length);
    if (a.startsWith("-m") && a.length > 2) return a.slice(2);
  }
  return undefined;
}

/** Pathspecs after `--`. */
export function pathspecs(args: string[]): string[] {
  const i = args.indexOf("--");
  return i === -1 ? [] : args.slice(i + 1);
}

export const FIXED_NOW = "2026-11-09T10:00:00Z";
