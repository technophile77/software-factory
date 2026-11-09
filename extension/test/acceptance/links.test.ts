import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, symlink, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLink } from "../../src/core/links";
import { makeRepo, type TempRepo } from "./fixtures";

let repo: TempRepo;
let outside: string;

beforeAll(async () => {
  repo = await makeRepo("linkrepo");
  await mkdir(join(repo.repoDir, "docs"), { recursive: true });
  await writeFile(join(repo.repoDir, "docs", "spec.md"), "# spec\n");
  outside = await realpath(await mkdtemp(join(tmpdir(), "sf-outside-")));
  await writeFile(join(outside, "secret"), "top secret\n");
  try {
    await symlink(outside, join(repo.repoDir, "escape"), "dir");
  } catch {
    // Symlinks may be unavailable (e.g. Windows without privilege); the test below checks for this.
  }
});

afterAll(async () => {
  await repo.cleanup();
  await rm(outside, { recursive: true, force: true });
});

function expectRefused(r: ReturnType<typeof resolveLink>) {
  expect(r.kind).toBe("refused");
  if (r.kind === "refused") expect(r.reason.trim().length).toBeGreaterThan(0);
}

describe("FR-11: links resolve to files and URLs", () => {
  it("FR-11: a file ref inside the repo resolves to its absolute path", async () => {
    const r = resolveLink(repo.repoDir, { kind: "file", ref: "docs/spec.md" });
    expect(r.kind).toBe("file");
    if (r.kind === "file") {
      expect(await realpath(r.absPath)).toBe(await realpath(join(repo.repoDir, "docs", "spec.md")));
    }
  });

  it("SR-3: an https URL resolves to a url link", () => {
    const r = resolveLink(repo.repoDir, { kind: "url", ref: "https://example.com/run/42" });
    expect(r).toEqual({ kind: "url", url: "https://example.com/run/42" });
  });
});

describe("AC-11 / SR-3: links outside the repo are refused", () => {
  it("AC-11: ../../secret is refused with a message", () => {
    expectRefused(resolveLink(repo.repoDir, { kind: "file", ref: "../../secret" }));
  });

  it("AC-11: a traversal that dips out and back in through a sibling is refused", () => {
    expectRefused(resolveLink(repo.repoDir, { kind: "file", ref: "docs/../../linkrepo-evil/x" }));
  });

  it("AC-11: an absolute path outside the repo is refused", () => {
    expectRefused(resolveLink(repo.repoDir, { kind: "file", ref: resolve(outside, "secret") }));
  });

  it("AC-11: a symlink inside the repo that points outside is refused (real path check)", async (ctx) => {
    const { lstat } = await import("node:fs/promises");
    const exists = await lstat(join(repo.repoDir, "escape")).then(() => true, () => false);
    if (!exists) ctx.skip(); // environment: symlinks not supported
    expectRefused(resolveLink(repo.repoDir, { kind: "file", ref: "escape/secret" }));
  });
});

describe("SR-3: only https URLs open", () => {
  for (const ref of [
    "http://example.com/",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "vscode://some.extension/run",
    "command:workbench.action.terminal.new",
    "ftp://example.com/x",
    "HTTP://example.com/",
  ]) {
    it(`SR-3: ${ref} is refused`, () => {
      expectRefused(resolveLink(repo.repoDir, { kind: "url", ref }));
    });
  }

});

// SR-3 classifies links by target, not by `kind`; the v1.0 contract does not enumerate kinds.
describe("SR-3: links with an unspecified kind are judged by their target", () => {
  it("SR-3: unknown kind with a relative ref inside the repo resolves as a file", async () => {
    const r = resolveLink(repo.repoDir, { kind: "transcript", ref: "docs/spec.md" });
    expect(r.kind).toBe("file");
    if (r.kind === "file") {
      expect(await realpath(r.absPath)).toBe(await realpath(join(repo.repoDir, "docs", "spec.md")));
    }
  });

  it("SR-3: unknown kind with a ref escaping the repo is refused", () => {
    expectRefused(resolveLink(repo.repoDir, { kind: "transcript", ref: "../../secret" }));
    expectRefused(resolveLink(repo.repoDir, { kind: "log", ref: resolve(outside, "secret") }));
  });

  for (const ref of ["http://example.com/log", "javascript:alert(1)", "file:///etc/passwd", "command:workbench.action.terminal.new"]) {
    it(`SR-3: unknown kind with non-https ref ${ref} is refused`, () => {
      expectRefused(resolveLink(repo.repoDir, { kind: "log", ref }));
    });
  }
});
