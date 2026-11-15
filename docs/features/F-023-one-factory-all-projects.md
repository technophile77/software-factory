# Feature: One factory for all projects

- **Id:** F-023
- **Status:** In review
- **Requested by / date:** Alex, 2026-11-15 ("it would be nice to have one
  factory that works on all projects that I give it")
- **Spec version:** 1
- **Depends on:** F-007 (engine, paths file, SR-5 pins, SR-13, SR-16),
  F-015 v23 (per-project and per-owner tokens, FR-19, PR #115),
  F-018 (`factory-engine interview`), F-021 v7 (`factory-engine inbox`
  console and watch mode), F-020 (JSON default for agent data)

## 1. Objective and business purpose
The owner wants to hand the factory a project and have the one running
factory pick it up, next to every other project, and to see all of them in
one place.

What the engine does today (main at 9334d79):

- **One engine process already runs several projects.** `factory-engine
  start` reads every config repo listed in `factory-projects.local.yaml` in
  the master clone and runs them side by side; a project that fails is
  stopped without stopping the others. Feature ids are unique across the
  engine (F-007 SR-16).
- **Each project is already kept apart:** its own GitHub token
  (`factory-token/<project>`, plus `factory-token/<project>/<owner>` for
  repos of another owner, F-015 FR-19), its own `factory/state` branch and
  `.factory/` worktree, its own pinned owner keys (SR-5), its own control
  channel (pipe or socket) and `engine.json`, its own inbox issues and
  sign-in setting.
- **The gaps the owner hits:**
  1. Giving the factory a project means hand-editing the YAML list (which
     must stay owner-only on Windows), running `factory-engine confirm
     --project <path>`, then restarting the engine, which stops every other
     project's work. `confirm` ends with "Restart the engine to run the
     project."
  2. The console (`factory-engine inbox`) and `factory-engine interview`
     find the engine through the folder they run in, so they see one
     project at a time. Run outside a project folder they refuse.
  3. The console's status lines (F-021 v7) already list features from every
     project, but don't say which project each belongs to.
  4. `factory-engine start` has to run from the master clone or be given
     `--master`.

## 2. Expected behavior
- `factory-engine project add <config repo path>` gives the factory a
  project. It runs today's checks and the SR-5 confirm (type the project
  name, approve the GitHub device sign-in), checks the project's token is
  stored, records the project in the registry, and the running engine
  starts it within a few seconds. Other projects carry on untouched.
- `factory-engine project list` shows every project with its state
  (running, stopped with the reason, disabled, waiting for a confirm) and
  config repo path.
- `factory-engine project remove <name>` stops that project in the running
  engine and takes it out of the registry. Its config repo, `factory/state`
  history, issues and pins are kept, so adding it back resumes where it was.
  It asks whether to also delete the project's token secrets (default: keep).
- `factory-engine inbox`, run from any folder, lists the open items of
  every running project, each labelled with its project name, and its watch
  mode shows every project's features as `<project> F-nnn: <status>`.
  `--project <name or path>` narrows it to one project, as today. Each
  project's console session still follows that project's
  `settings.interview_sign_in`.
- `factory-engine interview <feature id>` works from any folder: the engine
  knows which project the id belongs to. Without an id and outside a
  project folder it asks which project first.
- `factory-engine start` works from any folder once `engine.yaml` names the
  master clone (`master:`), as it already names `gitleaks:`.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | **Project registry.** The list of projects the engine serves is `<engine home>/projects.json` (schema `project-registry/1.0`, JSON Schema in `engine/src/schemas/`): `{ "schema": "project-registry/1.0", "projects": [{ "name", "path", "added_at" }] }`. Only `factory-engine project add/remove` writes it, atomically. (OQ-1) |
| FR-2 | **One-time import.** When `projects.json` is missing and `factory-projects.local.yaml` exists in the master clone, the engine imports its paths once (name from each manifest), writes `projects.json`, and logs that the YAML file is no longer read. The owner can delete it afterwards. |
| FR-3 | **`project add <path>`** runs, in order: today's path checks (`checkProjectPath`), manifest read, a name check (no other registry entry has the same name or the same real path), the SR-5 confirm (`confirmProject`, unchanged), a check that `factory-token/<name>` is in the credential store (if not, it says the exact `factory-engine secret set` command and stops before writing), then the registry write. Nothing is written if any step fails. |
| FR-4 | **`project remove <name>`** asks the owner to type the name, removes the entry, and asks "Also delete the stored tokens for <name>? (y/N)". It never touches the config repo, `factory/state`, issues or pins. |
| FR-5 | **`project list`** prints each registry entry with its state from the running engine (or "engine not running"). |
| FR-6 | **Live pick-up.** The running engine checks the registry every 5 seconds (size and modified time, then content). A new entry is started with the same start-up steps a project gets at engine start. A removed entry is stopped as a failing project is stopped today: its running agent sessions end, its listener closes, its `engine.json` is removed. Projects whose entry didn't change are not touched. (OQ-2) |
| FR-7 | **Engine index.** The engine writes `<engine home>/run/engine.json` (owner-only, never in a repo): `{ "schema": "engine-index/1.0", "pid", "projects": [{ "name", "config_repo", "channel" }] }`, listing running projects only, rewritten on every change and removed at stop. |
| FR-8 | **Console across projects.** `factory-engine inbox` with no `--project` and not inside an onboarded repo reads the engine index and opens a console session on each running project's existing channel. Items are listed as `<project> <item id>  <title>`; `inbox <item id>` needs `--project` only when two projects have that id. Answers go through the project's own channel and session, exactly as today. |
| FR-9 | **Status by project.** `engine.status` features gain `project` (the manifest name). The console's watch lines and the interview's status line show it. |
| FR-10 | **Interview from anywhere.** `factory-engine interview <feature id>` outside a project folder finds the feature's project through the engine index and `engine.status`; with no id it lists the running projects to pick from. |
| FR-11 | **Start from anywhere.** `engine.yaml` may hold `master: <absolute path>`; `--master` still wins, then `master:`, then the current folder. |
| FR-12 | **Separation stays code-enforced.** Every GitHub call, git push, inbox write and agent session for a project uses only that project's token(s), state worktree, pins and manifest. Removing or failing one project never changes another's state. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given an engine running project A, when `project add` is run for project B with a valid manifest, a stored token and an approved device sign-in, then within 10 seconds B is running, A's running sessions were not interrupted, and `project list` shows both running. | FR-3, FR-5, FR-6 |
| AC-2 | Given `project add` where the token is missing, the confirm is declined, the name is already registered, or the path is the master clone, then `projects.json` is byte-for-byte unchanged and the command says why. | FR-3 |
| AC-3 | Given A and B running, when `project remove B` is confirmed, then within 10 seconds B's listener is closed and its `engine.json` removed, A keeps running, and B's `factory/state` branch, issues and pins are unchanged; adding B back resumes its features at their recorded stages. | FR-4, FR-6 |
| AC-4 | Given only `factory-projects.local.yaml` with two paths, when the engine starts, then `projects.json` holds both projects by name, and a second start doesn't import again. | FR-2 |
| AC-5 | Given A and B each with an open inbox item `D-0001`, when `factory-engine inbox` runs outside any repo, then both are listed with their project names; `inbox D-0001` alone is refused with the two choices; `inbox D-0001 --project B` opens B's item. | FR-8 |
| AC-6 | Given B's `settings.interview_sign_in` asks for sign-in and A's doesn't, when the all-projects console answers an item of each, then only B's session asks for the GitHub sign-in. | FR-8 |
| AC-7 | Given features in A and B, then `engine.status` gives each one's `project`, and the watch lines read `A F-001: …` and `B F-001: …` style. | FR-9 |
| AC-8 | Given a fake GitHub that records the token on each request, when A and B run a feature to a pull request each, then no request for A's repos carries B's token or the reverse, and no commit lands on the other project's `factory/state`. | FR-12 |
| AC-9 | Given `engine.yaml` with `master:`, when `factory-engine start` runs from another folder, then it starts with that master clone. | FR-11 |
| AC-10 | Given a registry file that fails its schema, is a symbolic link, or (Windows) is writable by someone other than the owner, then the engine keeps running the projects it already had and files nothing new, and logs why; at start it refuses with that reason. | FR-1, SR-1 |
| AC-11 | `project-registry/1.0` and `engine-index/1.0` have JSON Schemas, and the state machine for a project's life in the engine (added, starting, running, stopping, removed) has the F-019 dead-end test. | FR-1, FR-6, FR-7 |

## 5. Constraints
- No new libraries. File checks reuse `paths-file.ts` (owner-only, size
  limit, no links, SDDL on Windows); the poll uses `fs.statSync`, not
  `fs.watch`, which is unreliable on Windows network and synced folders.
- The per-project channel, `engine.json` in each config repo and the
  `spec-interview` client stay as they are; the console reaches all projects
  by opening several of today's sessions, not through a new channel.
- No limit on how many projects or features run at once (ADR 0007 stays).
  Model endpoint slots are already shared across projects (F-013).
- Project lifecycle inside the engine is a jssm machine (ADR 0031).

## 6. Edge cases
- Two projects whose features would take the same id: unchanged, ids are
  handed out one at a time across the engine (F-007 SR-16), and a clash
  between already-existing ids is refused in both projects.
- A project removed while an agent is mid-commit: the stop waits for the
  current commit (as engine stop does today), then ends the session.
- `projects.json` edited by hand into something invalid while the engine
  runs: AC-10.
- A project re-added under a new config repo path with the same name: the
  confirm sees a new path, so SR-5 applies as for a first add.
- A project's token is revoked: that project stops with the reason, as
  today; others carry on.
- The owner runs two engines at once: the second start refuses because
  `run/engine.json` names a live pid.
- The engine index lists a project the console can't reach (pipe gone): the
  console shows "<project>: not reachable" and lists the rest.

## 7. Dependencies
- `engine/src/cli.ts`, `engine/src/engine.ts` (project start/stop, status),
  `engine/src/config/paths-file.ts`, `engine/src/config/confirm.ts`,
  `engine/src/secrets.ts`, `engine/src/terminal/interview.ts`,
  `engine/src/mcp/locate.ts`, `engine/src/mcp/operations.ts`.
- F-015 v23 per-owner tokens (merged, PR #115): FR-3 checks the project's
  main token only; per-owner tokens are checked when the project starts, as
  today. The "Onboard mesbot into the factory" thread is told before the
  build starts, so its onboarding uses `project add`.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | One owner and one engine per PC, running as the owner's OS user (as F-007, F-021 A-1). | — | Pending |
| A-2 | The engine home folder is owner-only and not synced to a cloud drive (as F-021 A-2), so the registry and engine index are safe there. | — | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | The registry decides which config repos (and so which owner ids) the engine trusts, so it gets today's paths-file checks: regular file, no link, at most 64 KiB, owner-only (SDDL on Windows, uid and mode elsewhere), schema-valid. A failing file is never partly applied. | Analyst (F-007 SR-13 carried over) | Pending |
| SR-2 | Adding a project always passes the SR-5 confirm with the GitHub device sign-in; the registry write happens only after it succeeds. Editing `projects.json` by hand adds no trust: a listed path without a matching pin waits for a confirm, as today. | Analyst (F-007 SR-5) | Pending |
| SR-3 | The engine index is written owner-only in the engine home, holds names, paths and channel addresses only (no tokens), and is never committed or sent anywhere. Clients apply today's `engine.json` checks to it (owner, mode, no link, size) and still check each channel's pid. | Analyst (F-005 SR-1) | Pending |
| SR-4 | A token secret is read only for the project named in its secret name; a test fails if any code path passes one project's token to another project's GitHub client (AC-8). | Analyst (F-015 SR-2) | Pending |
| SR-5 | `project add/remove` refuse unless stdin and stdout are terminals, and the engine refuses them from agent processes it started (F-018 SR-3, F-005 SR-14), so an agent can't add a project or delete tokens. | Analyst | Pending |

## 10. Interface requirements
Change-controlled edits, one hygiene item each, applied with the build after
the owner approves their text:

| Id | File(s) | Change | Status |
|---|---|---|---|
| H-0257 | `docs/interface-contracts.md` (Engine control channel v1.7) | `engine.status` features gain `project` (non-breaking add). New section for the engine index (`<engine home>/run/engine.json`, `engine-index/1.0`) and the client checks on it. | Pending |
| H-0258 | `docs/interface-contracts.md` (new: Project registry v1.0), `docs/architecture.md` § Data formats | `projects.json` format and who writes it; replaces the paths-file entry (H-0081), with the one-time import. | Pending |
| H-0259 | `docs/adr/0034-one-engine-registry.md` (new), `docs/adr/README.md` | Records: one engine serves every registered project; projects are added and removed live through commands; each keeps its own token, state and channel. | Pending |
| H-0260 | `README.md`, `engine/README.md`, `plugins/software-factory/skills/onboard-repo/SKILL.md` | Describe `project add/list/remove`, the all-projects console and `master:` in `engine.yaml`; the onboarding skill's last step becomes `factory-engine project add`. | Pending |
| H-0261 | `.gitignore`, `scripts/` CI check | Keep ignoring `factory-projects.local.yaml` for old clones; the "paths file never tracked" check also covers `projects.json` should one ever appear in the repo. | Pending |

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [ ] Assumptions explicit (A-1, A-2 pending the owner)
- [ ] Blocking decisions resolved (OQ-1, OQ-2; H-0257 to H-0261; Security and Testability Review not yet run)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-15 | Draft from the owner's request, after reading what the engine already does | — |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Where does the project list live? (a) **A JSON registry in the engine folder** written only by `project add/remove`, imported once from the YAML file. (b) Keep `factory-projects.local.yaml` in the master clone, now written by the commands. **Recommended: (a)**: once commands write it, it is engine data, which is JSON by default (H-0240), and it belongs with the pins and logs on this PC rather than in a repo clone. | Architecture | Open |
| OQ-2 | Does a new project start without restarting the engine? (a) **Yes, picked up live** within seconds; other projects are untouched. (b) No, `project add` says to restart, as `confirm` does today. **Recommended: (a)**: a restart stops every project's running agents, which grows worse with each project added. | Product | Open |
