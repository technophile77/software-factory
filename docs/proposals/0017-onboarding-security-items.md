# Proposal 0017: Close the open F-003 Code Review security items

**Status:** all decided by the owner on 2026-11-10 (decision cards). R2-1:
first option A, then changed to option B, a container per agent session,
once agents were to keep running as the owner (ADR 0014); the container
wording (H-0045 with H-0052) approved by the owner as drafted (card).
R2-2 A, R2-4 A, H-0048 and H-0049 approved as drafted. Recorded as ADR 0015
and in the Role policy and Inbox item contracts.

The F-003 Code Review review (`docs/features/F-003-code-review.md`) left five
findings that only the owner can close. All are Security decisions; R2-2 is
also an Interfaces change (Role policy). Hygiene ids: H-0045 to H-0049.

| Finding | Severity | Hygiene id | Question | Outcome |
|---|---|---|---|---|
| R2-1 | High | H-0045 | How Bash-capable agents are confined to their role's file and network rules | Decided B (container per agent session); contract text drafted |
| R2-2 | Medium | H-0046 | How the engine matches a path against a policy glob | Decided A; drafted text approved |
| R2-4 | Medium | H-0047 | How the engine knows an approval really came from the owner | Decided A; contract text added |
| R2-8 | Low | H-0048 | How the owner's installed plugin is pinned to a release | Approved as drafted |
| R2-10 | Low | H-0049 | How the factory's machine account is kept from approving PRs | Approved as drafted |

**Related:** proposal 0016 (owner presence and the agents' OS user, from the
thread closing F-005 SR-5) decides which OS account agents run as. This
proposal decides the rules applied inside that account. The two are designed
to be chosen together: R2-1 and R2-4 are only as strong as 0016's answer,
because an agent running as the owner can read the owner's credentials.

---

## R2-1 (H-0045). Confining Bash-capable agents (Security, Architecture)

**Problem.** The role policy's `read` and `write` lists bind the file tools
only. Four of the six core roles have `Bash`, and any program it runs can
read or write any file: `git show HEAD:.env`, `git checkout <ref> --
CLAUDE.md`, `git -c alias.x='!sh …' x`, and every build or test tool by
design. The validator's deny list of shells and interpreters is a guard rail,
not a boundary. ADR 0004 chose "worktree + engine-enforced permissions, not
an OS sandbox", and named containers as a later step.

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Claude Code's sandbox per agent session (recommended)** | The engine turns each role's policy into the session's sandbox settings: `filesystem.allowRead`/`denyRead`, `allowWrite`/`denyWrite` from `read` and `write` (deny wins), `network.allowedDomains` from `network`. It sets `failIfUnavailable: true`, `allowUnsandboxedCommands: false` and no `excludedCommands`, and loads only the settings it generates, never the repo's `.claude/` settings, hooks or MCP servers. File tools keep using permission rules built from the same lists. On Windows the engine runs agent sessions inside WSL2, because the sandbox does not run on native Windows | OS-enforced for every child process; one source of rules; little extra software on macOS and Linux | Needs WSL2 on Windows; only Bash is sandboxed, so the engine must keep hooks and MCP servers out of agent sessions; residuals below |
| B. A container per agent session | Each session runs in a container with the worktree mounted; read-only mounts and a firewall stand in for the rules | Whole-process boundary, including hooks | Needs Docker Desktop; slower; per-file denies inside the worktree become coarse mounts; more upkeep |
| C. No sandbox; the contract says file rules bind the file tools only | Rely on 0016's separate OS user to protect the owner's own files, and on review gates and branch protection for the rest | No new work | Inside the worktree a misbehaving agent can still read secret files and write change-controlled files; Code Review R2-1 stays open |

**Residuals of A**, to record as known limits: a secret already committed
can still be read through git objects (`git show`), so `assess` keeps
scanning for committed secrets; the sandbox's network filter trusts the host
name, so an allowed host should never be a broad one; build and test tools
still run repo code, within the sandbox.

**Wording for the Role policy contract if A is chosen** (replaces "`commands`
may not name a shell … arguments are not restricted"):

> The engine runs every session of a role with `Bash` in an OS sandbox whose
> filesystem rules are the role's `read` and `write` lists (deny wins) and
> whose network rule is its `network` list. If the sandbox can't start, the
> session doesn't start. Commands never run outside the sandbox. `commands`
> may not name a shell, interpreter or command wrapper; that check is a
> guard rail, and the sandbox is the boundary.

ADR 0004 would get a successor ADR recording the change.

## R2-2 (H-0046). Matching paths against policy globs (Interfaces, Security)

**Problem.** Globs were defined as text only. On case-insensitive
filesystems (macOS and Windows defaults) `claude.md` or `.GITHUB/workflows`
reach denied files without matching a deny glob. A symlink such as
`src/ci -> ../.github/workflows` turns `src/**` into a workflow write. Glob
libraries read `?`, `[...]`, braces and extglobs differently, which let
`.factory/[[:punct:]][[:punct:]]/CLAUDE.md` pass as a factory-only write.

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. One fixed rule (recommended, drafted)** | Resolve the real path (following symlinks), refuse it outside the worktree, match it relative to the worktree after Unicode NFC normalization. Deny globs match case-insensitively everywhere; allow globs case-sensitively. Dialect: literal segments, `*` within a segment, `**` across segments; `?`, classes, braces and extglobs refused | Same answer on every OS; a deny can only get wider; simplest dialect to implement identically in TypeScript and Python | A rule that used `?` or `[...]` must be rewritten (no manifest uses them today) |
| B. Same, but fold case only on case-insensitive filesystems | Engine detects the filesystem | Exact on Linux | A repo moved between machines behaves differently; more code |
| C. Leave matching to the engine implementation | Status quo | None | Code Review R2-2 stays open |

**Drafted here:** the Role policy text in `docs/interface-contracts.md`, and
the validator now refuses `?`, `[` and `]` as well as braces and extglobs
(tests updated: `src/[abc]*.py` and `lib/?/**` are now refused).

## R2-4 (H-0047). Knowing an approval came from the owner (Security)

**Problem.** An owner action in an inbox item is a `by: owner` line in
`history`. The orchestrator may write `.factory/inbox/**`, and the item is
committed with the factory token, so a misbehaving agent can record the
owner approving a Security or hygiene item. The engine would be trusting a
client-supplied identity field.

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Owner actions are signed commits (recommended)** | The inbox extension signs each owner-action commit with the owner's SSH signing key (`git commit -S`). The engine counts a `by: owner` entry only if its commit is signed by a key listed as the owner's signing key on GitHub (`GET /users/<login>/ssh_signing_keys`), and files a Security alert for an unsigned or wrongly signed one. Optional: keep the key on a hardware key so each approval needs a touch | Standard git; works offline once keys are cached; the record is self-checking in the repo | One-time setup by the owner: add a signing key to GitHub. Holds only if agents can't use the key, which is 0016's separate OS user (or a hardware key) |
| B. Owner actions are written through the GitHub API | The extension commits through the API with the owner's VS Code GitHub sign-in; the engine checks GitHub's verified flag and the author's user id | No key setup | Network needed for every approval; larger extension change; holds only if agents can't read the owner's GitHub sign-in (0016 again) |
| C. Keep plain `by: owner` lines until Alpha | Record as an accepted Security risk, like F-005 SR-5 | No work now | An agent can forge approvals until fixed |

**Wording for the Inbox item contract if A is chosen** (added after "Each
action is one commit whose message starts with the item id."):

> The commit must be signed with one of the owner's SSH signing keys as
> listed on GitHub. The engine ignores an owner action whose commit is not,
> and files a Security alert for it.

Both A and B need an F-001 extension change, filed as a feature after the
decision. No engine exists yet, so nothing counts approvals today.

## R2-8 (H-0048). Pinning the installed plugin (Security), drafted

**Problem.** The plugin is installed from whatever is on `main` when the
owner adds or updates the marketplace, and nothing checks the installed
copy against the factory version the project pinned. This code runs with
the owner's `gh` login.

**Drafted change:**
- README and the onboarding skill install with
  `/plugin marketplace add technophile77/software-factory@v<version>`, a
  release tag, never `main`.
- Release rule: every release is tagged `v` plus the `version` in
  `plugins/software-factory/.claude-plugin/plugin.json`.
- New `factory_check.py plugin-version [--manifest <file>]`. Step 1 of the
  onboarding skill pins the installed plugin's tag; on a project that
  already has a manifest, it stops and tells the owner if the manifest's
  `factory.version` is a different tag. Four new tests.
- **After approval:** tag the merge commit `v0.2.0` (the current plugin
  version) so the install line works; the owner re-adds the marketplace at
  that tag.

## R2-10 (H-0049). Code owner review (Security), drafted

**Problem.** The factory's machine account has Write and can approve PRs it
didn't author. `required_approving_review_count: 1` accepts any writer's
approval, so on an owner-authored PR the factory's approval satisfies the
rule.

**Drafted change:**
- Onboarding step 4 adds `.github/CODEOWNERS` naming the owner (agents may
  not write `.github/**`). Step 8 adds `require_code_owner_reviews: true`,
  applied after the onboarding PR with `CODEOWNERS` merges.
- `assess` reports branch protection as incomplete without code owner
  review (tests updated).
- This repo gets `.github/CODEOWNERS` (`* @technophile77`). **After merge
  the owner turns on "Require review from Code Owners"** for `main` in the
  repo's branch protection settings; an agent can't change repo settings.
- Unchanged: the owner still merges the PRs they author with their admin
  bypass, because GitHub doesn't let anyone approve their own PR.

## Recommendation

R2-1 A together with 0016's separate OS user; R2-2 A; R2-4 A; approve
H-0048 and H-0049 as drafted.
