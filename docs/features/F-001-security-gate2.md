# F-001 Security Gate 2 (implementation review)

- **Feature:** F-001 Decision inbox in VS Code, spec v2
- **Gate:** 2, implementation review against `docs/security-standards.md` (S1 to S7) and spec SR-1 to SR-5
- **Diff reviewed:** `git diff origin/main...HEAD` on `feature/F-001-decision-inbox` (`extension/`, `.github/workflows/extension.yml`, `scripts/check_docs.py`, docs)
- **Reviewer role:** security-reviewer
- **Date:** 2026-11-09
- **Maturity level:** Rapid prototype (only Critical blocks)
- **Result:** PASS. No Critical findings. 1 High, 3 Medium, and 9 Low findings are non-blocking at this level. Record them as known issues; they count against promotion. The High must be fixed before Alpha.

## Findings

| # | Criterion | Severity | Blocks? | Location (file:line) | Finding | Suggested fix |
|---|---|---|---|---|---|---|
| 1 | S1.3, S6.1 | High | No | `extension/src/extension.ts:19-21`, `extension/src/core/store.ts:53-59` | `execFile("git", …, { cwd: factoryDir })` runs a bare `git`. On Windows, libuv searches the child's cwd for `git.exe` and `git.com` before `PATH`. The cwd is `.factory/`, the `factory/state` worktree, and agents and anyone who can push to that branch write its contents. A planted `.factory/git.exe` would run as the owner the first time they click any action. The preconditions are Windows (a stated target platform), a trusted workspace, and attacker-controlled content on `factory/state`. I derived this from libuv's documented `search_path` behaviour and have not reproduced it on Windows. | Resolve git to an absolute path before running it. Use the built-in `vscode.git` extension API (`git.path`), or search `PATH` yourself and skip any entry inside the workspace. Fail closed if git is not found. Add a test that the runner never gets a bare `git`. |
| 2 | S1.2, S1.3 | Medium | No | `extension/src/core/store.ts:50-54`, `extension/src/core/store.ts:22-24` | The item path goes to `git add -- <rel>` as a pathspec. `--` stops option injection but not glob matching. I reproduced this on Linux: an item file named `*.md` in the decision folder, acted on by the owner, made `git add` stage every other `.md` there. That included an agent's uncommitted edit setting another item to `status: approved`, which then stays staged for the next commit. Nothing ties the file name to the item id either, so two files can carry the same id (AC-6, "touches only that item file"). | Run git with `--literal-pathspecs` (or set `GIT_LITERAL_PATHSPECS=1`, or prefix `:(literal)`). In `loadInbox`, accept only files named `<id>.md` whose name matches the frontmatter `id`, and list any other file as an error (FR-10). |
| 3 | S5.1 | Medium | No | `extension/src/core/store.ts:22-24`, `extension/src/extension.ts:92-100,155,168` | If one entry in the decision folder can't be read, `loadInbox` throws for the whole inbox. Examples are a directory named `x.md` (reproduced: `EISDIR`), a dangling symlink, or a file without read permission. `refresh()` is called with `void`, so the rejection is unhandled and no error is shown. On first load the view then says **"No decisions waiting."** while blocking items exist. One stray file from an agent hides every pending decision, which fails open and goes against FR-10. | Catch each file's read error and add it to `errors`, as parse failures already are. Catch errors in `refresh()` and show an error node or message instead of the empty state. |
| 4 | S6.3 | Medium | No | `scripts/check_docs.py:16-32`, `.github/workflows/extension.yml` (new) | Both paths are change-controlled: `CLAUDE.md` rule 3 covers both, and ADR 0008 covers `.github/workflows/`. The branch edits the first and adds the second with no Configuration hygiene item or owner approval. The changes themselves are harmless (skip `node_modules`; read-only CI). The problem is that change control was bypassed. | File a hygiene item for each change (file, reason, diff, risks, recommendation) and get approval before merge. Otherwise move both changes out of this PR. |
| 5 | S4.1 | Low | No | `extension/package.json:61-74` | The new runtime dependencies `markdown-it` and `yaml`, and the dev tools `esbuild`, `vitest` and `typescript`, have no Architecture decision approving them. The test report calls them "approved libraries", but no ADR or decision record says so. Direct risk is low: versions are pinned, the lockfile is committed, and `npm audit` is clean. | Raise an Architecture decision listing the libraries and their versions, and record it as an ADR before merge. |
| 6 | S1.4 | Low | No | `extension/src/core/store.ts:18-24,65-69` | Inbox files are read through symlinks with no check that they stay in the repo. A `.factory/inbox/decision/x.md` symlink, or a symlinked `decision/` folder, makes the view read and display a file outside the repo. YAML parse errors can quote lines of that file. Only files shaped like items show in full. On write, `rename` replaces the symlink. | `lstat` each entry and skip or flag any symlink. Alternatively, `realpath` the entry and confirm it is inside `realpath(factoryDir)`. |
| 7 | S1.4 | Low | No | `extension/src/core/links.ts:30-34` | When the link target doesn't exist, `realpath` fails and the code falls back to the lexical path. A link through a symlinked directory to a missing file (`escape/new.md`) is then allowed, and saving that editor writes outside the repo. There is also a race between the check and `vscode.open`: a symlink can be swapped in between. | `realpath` the deepest existing ancestor and check that it is inside the repo. Refuse links to missing targets, or open them read-only. |
| 8 | S1.4 (SR-3) | Low | No | `extension/src/extension.ts:113-114` | The repo root is looked up by workspace folder **name**. Two open folders can share a name (for example two `app` folders). An item from repo B would then have its links resolved inside repo A, against SR-3's "inside the item's repo", and git would run in the wrong worktree. | Store `repoDir` and `factoryDir` on `QueueEntry` and look up roots by those paths, not by display name. |
| 9 | S1.1 | Low | No | `extension/src/extension.ts:112-118,122-124` | Webview messages are only partly validated. `msg.index` is not checked to be an integer in range, and a key such as `"constructor"` makes `resolveLink` throw an unhandled error. `note` and `option` have no length limit. Today only the extension's own nonce script can post messages, so this is defence in depth. | Check that `Number.isInteger(index)`, that it is within `links.length`, and that `note`/`option` are bounded strings. Ignore anything else. |
| 10 | S6.1 (SR-2) | Low | No | `extension/src/core/render.ts:70,90-93`, `extension/src/extension.ts:146` | A Markdown link in the body can show text unlike its target: `[docs/a.md](https://evil.example)` displays as a file name but opens an external site (reproduced). It still needs the owner's click, so SR-2 is met, but this is a phishing aid written by an agent. | For body links, show the resolved target, for example in a confirmation before `openExternal` or as visible text. Alternatively, render body links as text and open only the item's `links` list. |
| 11 | S5.1 | Low | No | `extension/src/core/store.ts:55-59,65-69` | Robustness gaps in the atomic write and rollback:<br>(a) the temp file is left behind if the write fails;<br>(b) there is no `fsync` before `rename`;<br>(c) if restoring the original fails, `git reset` is skipped and the original git error is lost;<br>(d) the rollback overwrites any agent edit made since the read (concurrent-edit edge case).<br>The temp file name is predictable. | Use try/finally to unlink the temp file. `fsync` before `rename`. Run the reset and rethrow the original error even if the restore fails. Before restoring, compare the file to the bytes written and skip the restore if they differ. Create the temp file with `wx`. |
| 12 | S7.1 (SR-5) | Low | No | `extension/src/core/item.ts:84-86` | A `__proto__` frontmatter key is not kept. `extra[k] = v` sets the object's prototype instead of a field, so the key is silently dropped on write (reproduced). SR-5 requires unknown fields to be preserved. No global prototype pollution occurs. | Build `extra` with `Object.create(null)` or `Object.defineProperty`, or use a `Map`. |
| 13 | S4.3 | Low | No | `.github/workflows/extension.yml:17-18` | The third-party actions are referenced by moving tags (`@v4`), not commit SHAs. The workflow is read-only, which limits the impact. | Pin `actions/checkout` and `actions/setup-node` to full commit SHAs, with a comment giving the version. |

## Checked and fine

- **SR-1 / AC-12, webview:**
  - The CSP is `default-src 'none'` with nonce-only `script-src` and `style-src`, so there are no remote, image or frame sources.
  - The nonce is 16 random bytes for each render.
  - `localResourceRoots: []`, and command URIs are not enabled.
  - markdown-it runs with `html: false`. Raw `<script>`, `<img onerror>` and iframes come out as escaped text (verified).
  - markdown-it's `validateLink` drops `javascript:`, `vbscript:` and `file:` links, case-insensitively (verified). The `data:image` URIs it allows are blocked by the CSP.
  - Every frontmatter field in the card goes through `esc()`, which encodes `& < > " '`.
- **Body and item links** both go through `resolveLink` before anything opens. Nothing opens or runs without a click (SR-2, by inspection).
- **SR-3 / AC-11, `links.ts`:**
  - Only `https:` URLs open.
  - `..` escapes, absolute paths, Windows drive paths (`C:\`, `C:/`), drive-relative paths (`C:..`), UNC and `\\?\` paths are all refused.
  - Cross-drive results from `path.relative` are caught.
  - A symlink to an existing file outside the repo is refused through `realpath`.
  - Comparison is case-insensitive on Windows through `path.win32`.
- **SR-4:**
  - `execFile` is called with an argument list and no shell.
  - Item ids are checked against `^[DTH]-\d{4,}$` at parse time and again before the write and commit.
  - The commit message is one `-m` argument built only from the checked id and a fixed verb.
  - `--` comes before the path, and the path always starts with `inbox/`, so git's `:` pathspec magic can't apply.
- **SR-5:**
  - Writes go to a temp file and are then renamed.
  - Unknown fields round-trip (except finding 12).
  - Notes containing `---`, newlines or YAML are serialized safely: I could not inject a field or forge a status through a note (verified).
  - The YAML alias limit (`yaml` default) guards against alias bombs.
- **S4.2:** `npm audit` reports 0 vulnerabilities, both overall and with `--omit=dev`. Installed versions: markdown-it 14.3.3, yaml 2.9.1, esbuild 0.28.2, vitest 5.1.0.
- **S4.3:** Exact versions are in `package.json`, and `package-lock.json` is committed. CI uses `npm ci`.
- **CI permissions:** `permissions: contents: read`. The trigger is `pull_request`, not `pull_request_target`, and no secrets are used.
- **Workspace trust:** `package.json` declares no `untrustedWorkspaces` support, so the extension stays disabled in Restricted Mode.
- **S2 and S3:** The extension handles no secrets, credentials or personal data, and has no auth surface beyond the local single-user model. Git stderr shown in error messages goes only to the local owner.
- **S7.1:** SR-1, SR-3, SR-4 and SR-5 have automated tests. SR-2 has a stated reason it is checked by inspection only (it needs the extension host).

## Orchestrator follow-up (2026-11-09)

| # | Resolution |
|---|---|
| 1 (High) | Fixed. Git now runs by absolute path, from VS Code's Git extension or a `PATH` search that skips workspace folders; the action is refused if git isn't found. |
| 2 (Medium) | Fixed. `GIT_LITERAL_PATHSPECS=1` is set, and an item file must be named `<id>.md`, both when loading and when acting. |
| 3 (Medium) | Fixed. Unreadable or non-regular entries are listed as errors, and a load failure shows an error message instead of an empty inbox. |
| 4 (Medium) | Fixed for this PR. The change-controlled edits (`scripts/check_docs.py`, `.github/workflows/extension.yml`) are presented in the PR as config hygiene items, so merging approves them. |
| 5 (Low) | Not a gap. The owner approved the libraries on 2026-11-09; this is now recorded as ADR 0011. Versions were raised after `npm audit`. |
| 6 (Low) | Fixed. Entries are checked with `lstat`, and symlinks are refused. |
| 8, 9 (Low) | Fixed. The repo is looked up by path, the link index is range-checked, and note and href lengths are capped. |
| 12 (Low) | Fixed. The `__proto__` key is preserved, with a regression test. |
| 7, 10, 11, 13 (Low) | Known issues. They don't block at Rapid prototype, and they count against promotion to Alpha. |
