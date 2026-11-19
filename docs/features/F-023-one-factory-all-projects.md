# Feature: One factory for all projects

- **Id:** F-023
- **Status:** Approved (owner sign-off 2026-11-19 02:26Z, decision card); Security and Testability Review next
- **Requested by / date:** Alex, 2026-11-15 ("it would be nice to have one
  factory that works on all projects that I give it"); v2: Alex,
  2026-11-19 02:00Z (one factory per machine; portable projects; feature
  ids unique per project, not per engine; the onboarding skill gives the
  factory a project, or the owner does it by hand; review every place where
  uniqueness spreads across project boundaries)
- **Spec version:** 3
- **Depends on:** F-003 (onboarding skill), F-007 (engine, SR-5 pins,
  SR-13, SR-16), F-015 v23 (per-project and per-owner tokens, FR-19),
  F-018 (`factory-engine interview`), F-021 v7 (`factory-engine inbox`
  console), F-020 (JSON default; hand-edited config stays YAML)

## 1. Objective and business purpose
The owner wants one factory per PC that works on every project he gives it,
and projects that can move from one factory to another and carry on where
they left off.

What the engine does today (main at f7df5f7):

- **One engine process already runs several projects**, listed by path in
  `factory-projects.local.yaml` in the master clone. A project that fails
  is stopped without stopping the others.
- **Each project already has its own** GitHub token(s) (F-015 FR-19),
  `factory/state` branch, pinned owner keys (SR-5), control channel,
  inbox issues and sign-in setting.
- **The gaps:**
  1. Nothing stops a second engine on the same PC (`--home` gives it a
     second engine folder).
  2. Adding a project means hand-editing the shared list, running
     `factory-engine confirm`, then restarting the engine, which interrupts
     every other project. The onboarding skill doesn't do it.
  3. Feature ids are unique across the whole engine (F-007 SR-16, OQ-10),
     so a project's ids skip numbers taken by other projects.
  4. Engine-folder state is keyed by the config repo's **path** (pins,
     run records, chain heads, filed-alert keys, console files). Moving a
     project to another folder or PC loses it, so it can't pick up where it
     left off.
  5. The console and `interview` find the engine through the folder they
     run in, so they see one project at a time.

## 2. Expected behavior
- **One factory per PC.** Starting a second engine as the same OS user
  fails with "A factory is already running on this PC (pid N)", whatever
  `--home` or `--master` it was given.
- **A project file per project.** The factory serves every project that
  has a file in `<master clone>/projects/` (git-ignored), named
  `<project name>.yaml`:

  ```yaml
  # One project this factory serves (F-023). Move this file to another
  # factory to move the project.
  name: example-project
  config_repo:
    url: https://github.com/example-owner/example-project-factory
    path: /path/to/example-project-factory   # this PC's clone
  ```

- **Giving the factory a project** is the onboarding skill's last step:
  it writes the project file and lists the setup steps left. The owner can
  also write or copy the file by hand. The running factory sees a new or
  changed file within a few seconds and starts the project without touching
  the others; deleting the file stops it.
- **Setup steps** the factory checks, in order, and shows in the console
  as "needs setup" with the exact command until each is done:
  1. The config repo clone is at `config_repo.path` (if it's missing, the
     factory clones `config_repo.url` there once the token is stored).
  2. The project's token(s) are stored (`factory-engine secret set
     factory-token/<name>`, plus any per-owner tokens).
  3. The owner confirms the project on this factory (`factory-engine
     confirm --project <name>`, the SR-5 GitHub device sign-in).
  4. No other factory is serving the project (the lease, FR-7).
- **Moving a project:** stop it on the old factory (delete its file there,
  or that factory is gone), copy the file to the new factory, do the setup
  steps. Interviews, inbox items, build state and pull requests carry on
  from `factory/state` and GitHub. What stays on the old PC: console
  private detail and agent sessions in progress (the run restarts from its
  last commit).
- **Feature ids per project.** Each project numbers its own features from
  F-001. Two projects can both have an F-001.
- **Repos shared by projects, with no configuration.** Each feature's
  spec says which repos it changes; the factory knows which projects use
  each repo. A feature that only reads a repo never claims it. A feature
  that changes a repo another project also uses checks it out first;
  other projects' changes to it wait until that feature's pull request
  merges or closes.
- **The console** (`factory-engine inbox`) run from any folder lists every
  project's items as `<project> <item id>  <title>`, and its watch lines
  read `<project> F-001: <status>`. `--project <name>` narrows it to one.
  `factory-engine interview <project> <feature id>` works from any folder;
  inside a project's repo the project can be left out, as today.
- `factory-engine start` works from any folder once `engine.yaml` names
  the master clone (`master:`).

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | **One factory per PC.** At start the engine takes a per-user lock that doesn't depend on `--home` or `--master` (a fixed named pipe on Windows, a fixed socket path under the user's runtime folder elsewhere) and refuses to start while another live engine holds it, naming its pid. |
| FR-2 | **Project files.** The factory's projects are the `*.yaml` files in `<master clone>/projects/` (git-ignored, schema `project-file/1.0` with a JSON Schema): `name` (as the manifest's), `config_repo.url` (https GitHub URL), `config_repo.path` (absolute). The file name is `<name>.yaml`. Nothing else is allowed in it. |
| FR-3 | **One-time import.** If `projects/` is missing and `factory-projects.local.yaml` exists, the engine writes one project file per listed path (name and URL from the manifest and `origin`) and logs that the old file is no longer read. |
| FR-4 | **Live pick-up.** The engine checks `projects/` every 5 seconds (names, sizes, modified times, then content). A new file starts that project through the setup steps; a changed file is re-checked; a deleted file stops the project as a failing project is stopped today (sessions end after the current commit, listener closes, `engine.json` removed, lease released). Other projects are not touched. |
| FR-5 | **Setup steps.** For each project the engine reports its first unmet step (clone, token, confirm, lease) with the exact command, in the console and the log. Once all are met it runs the project. `factory-engine confirm --project` accepts a project name as well as a path. |
| FR-6 | **Onboarding writes the file.** The onboarding skill's last step writes `projects/<name>.yaml` (after the owner's yes) and lists the setup steps left. Writing the file by hand has the same effect. |
| FR-7 | **Only one factory writes to a project (lease).** A running project holds a lease on its `factory/state` branch: `.factory/lease.json` (`factory-lease/1.0`: factory id, started, renewed). The factory id is random, made once per engine folder. (a) **Before starting** a project, the factory reads the lease from the remote; one held by another factory and renewed within 30 minutes makes it refuse the project with "<name> is served by another factory". (b) **Taking the lease** is a commit pushed to `factory/state`; git refuses a push that isn't a fast-forward, so if two factories try at once only one wins and the other refuses. (c) **On every push** to `factory/state` the factory first checks that the remote lease is still its own; if not, it stops the project at once: no more pushes, no agent sessions, no GitHub writes for it (issues, comments, branches, pull requests, merges). (d) The lease is renewed every 10 minutes while the project runs. (e) **Takeover** only through `factory-engine confirm`, which shows the other factory's lease and its last renewal and asks the owner to type the project name; the old factory then stops at its next push or renewal (c). Code, not a model, makes every one of these checks. |
| FR-8 | **Portable state.** Everything needed to carry on lives in the config repo (`factory/state`) or GitHub. Engine-folder state is keyed by project name, not path: pins, run records, chain heads, console files, worktrees. Filed-alert keys move to `factory/state` so a moved project doesn't file the same alert twice. On a factory that has never seen the project, the chain head is taken from the commit the owner confirmed (FR-5 step 3), and interrupted runs restart from their last commit. |
| FR-9 | **Feature ids per project.** A new feature takes one more than the highest id in its own project (its feature records, `feature/` branches in its config and code repos, `docs/features/` on main). The engine-wide id record, the "Feature id exists in more than one project" alert and the refusal of a duplicate id go. Inside the engine every feature is keyed by project name and id together. |
| FR-10 | **Every cross-project map is keyed by project.** Running jobs, analyst runs, held-command answers, status, pause and resume key by project and id, never by a bare feature id or inbox item id. |
| FR-11 | **Shared repos: claimed only by features that change them.** No configuration marks a repo shared or read-only. (a) The feature's signed-off spec lists the repos it changes (`Repo:` lines, F-015 FR-16); every other repo the project lists is only read for that feature: the factory clones and fetches it, and makes no checkout, push, branch, pull request, issue or label there. A repo only read never blocks anyone. (b) A repo that only one project uses: unchanged from today. (c) A repo that another project also uses (on this factory, from the project files' manifests; on another factory, from a checkout record already in the repo, FR-11b): before the feature's first change there, the factory checks the repo out for that feature. While it is held, no other project changes the repo; its features wait with the status "waiting for <owner/repo>, checked out by <project> <feature>". It is released when the feature's pull request there merges or closes, or the feature is stopped. Features of the same project share the project's checkout. How overlapping features of different projects settle the change is FR-11c. |
| FR-11b | **The checkout record.** A checkout is `checkout.json` (`repo-checkout/1.0`: project name, feature id, factory id, taken, renewed) on a `factory/checkout` branch in the shared repo itself, so factories on different PCs see the same record. It is taken and released only by a fast-forward push, so two factories racing for it can't both win. It is renewed every 10 minutes while held. One not renewed for 30 minutes can be released by the owner through `factory-engine confirm`, which shows it and asks the owner to type the repo name; code never releases another project's checkout on its own. In a shared repo, feature branches carry the project name (`feature/<project>/F-nnn-<slug>`), since feature ids are per project. |
| FR-11c | **Joint or independent: an Architecture decision, unanimous for joint.** When a feature's spec (at the readiness gate) names a repo that an open feature of another project also changes, code finds the overlap and the analysts of both features write one Architecture decision item, filed in **each** project's inbox, with two options: (A) **Joint change:** one interface proposal that meets both features' requirements, attached in full; (B) **Independent changes:** each feature changes the repo on its own, in checkout order, the later one re-planning on the merged code. Neither feature passes the readiness gate until the decision is made. Joint is recorded only when the owner of **every** involved project chooses A in that project's own inbox; any B, or a project that hasn't answered within the item's wait, means independent. With joint, the interface proposal is added to both specs as an approved interface requirement and the builds take turns implementing it. Code, not a model, counts the answers. |
| FR-11d | **Each project guards what it relies on.** Every project that changes a shared repo adds tests there for what it relies on; any change from any project must pass all of them before it merges. When two projects' changes undo each other more than twice, the factory stops both features and files an Architecture decision in both inboxes. |
| FR-12 | **Engine index.** The engine writes `<engine home>/run/engine.json` (owner-only, `engine-index/1.0`: pid, and each running project's name, config repo path and channel), rewritten on each change, removed at stop. |
| FR-13 | **Console across projects.** `factory-engine inbox` outside a project folder reads the engine index and opens a session on each running project's existing channel, each following that project's `settings.interview_sign_in`. `inbox <item id>` needs `--project` when more than one project has that id. |
| FR-14 | **Status by project.** `engine.status` features gain `project`; `pause` and `resume` take an optional `project`. The console's watch lines and the interview's status line show the project name. |
| FR-15 | **Interview from anywhere.** `factory-engine interview [<project>] [<feature id>]`: outside a project folder the project is required, or picked from the running projects. |
| FR-16 | **Start from anywhere.** `engine.yaml` may hold `master: <absolute path>`; `--master` wins, then `master:`, then the current folder. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a running engine, when a second `factory-engine start` runs with a different `--home` and `--master`, then it exits non-zero naming the first engine's pid, and the first keeps running. | FR-1 |
| AC-2 | Given an engine running project A, when a valid `projects/B.yaml` appears and B's setup steps are met, then within 10 seconds B is running and A's sessions were not interrupted. | FR-2, FR-4 |
| AC-3 | Given `projects/B.yaml` whose token isn't stored, then the console shows "B: needs setup" with the `secret set` command, and nothing is pushed for B; after the token is stored, the next step (confirm) is shown. | FR-5 |
| AC-4 | Given B running with an open interview and an open inbox item, when its file is deleted, the config repo is cloned to another folder, and a new project file pointing there is written and set up on a fresh engine folder, then the interview carries on at its next question, the item is still open and answerable, no alert is filed a second time, and no feature id changes. | FR-4, FR-7, FR-8 |
| AC-5 | Given B's lease renewed 5 minutes ago by another factory id, then this factory refuses B with the "served by another factory" reason; after the owner takes it over through `confirm`, B runs and the lease names this factory. | FR-7 |
| AC-5b | Given two factories with the same project file started at the same moment against one remote, then exactly one holds the lease and runs the project; the other shows "served by another factory" and has made no GitHub write for it. | FR-7 |
| AC-5c | Given factory X running B, when the owner takes B over on factory Y, then X's next push or renewal finds Y's lease, X stops B, and X makes no further push, issue, comment, branch or pull request write for B. | FR-7 |
| AC-6 | Given projects A and B, when each starts its first feature, then both are F-001, both run, and status, pause, resume, inbox answers and held-command answers for one never reach the other. | FR-9, FR-10, FR-14 |
| AC-7 | Given A and B both listing repo R, and features in both whose specs don't change R, when both run, then neither takes a checkout and no branch, push, pull request, issue or label is made in R. | FR-11 |
| AC-7b | Given A and B both listing R, and a feature in each whose spec changes R, when A's feature starts changing R, then A holds the checkout, B's feature waits with the "checked out by" status and makes no write to R, and when A's pull request merges B's feature takes the checkout and continues, on a `feature/B/F-nnn-…` branch. No manifest or project file was edited. | FR-11, FR-11b |
| AC-7c | Given two factories racing to check out R for different projects against one remote, then exactly one push wins and the other project waits. | FR-11b |
| AC-7e | Given open features in A and B whose specs both change R, when the later one reaches the readiness gate, then one Architecture item is filed in A's inbox and one in B's with the same options and proposal, and neither feature passes the gate until both are answered. | FR-11c |
| AC-7f | Given that item, when A's owner answers Joint and B's owner answers Independent (or doesn't answer in time), then independent is recorded in both projects; only Joint in both records joint, and then the proposal appears in both specs as an approved interface requirement. | FR-11c |
| AC-7g | Given B's test in R for what B relies on, when A's change in R breaks it, then A's pull request doesn't merge; and a third round of the two projects undoing each other stops both features with an Architecture item in each inbox. | FR-11d |
| AC-8 | Given only `factory-projects.local.yaml` with two paths, when the engine starts, then `projects/` holds a file for each, and a second start doesn't import again. | FR-3 |
| AC-9 | Given A and B each with an open item `S-0001`, when `factory-engine inbox` runs outside any repo, then both are listed with their project names; `inbox S-0001` alone is refused with the two choices; `inbox S-0001 --project B` opens B's. Each session follows its own project's sign-in setting. | FR-12, FR-13 |
| AC-10 | Given a fake GitHub that records the token on each request, when A and B each run a feature to a pull request, then no request for A's repos carries B's token or the reverse, and nothing lands on the other project's `factory/state`. | FR-8, FR-10 |
| AC-11 | Given a project file that fails its schema, is a link, names a path that isn't a Git work tree, or (Windows) is writable by someone other than the owner, then that project is refused with the reason, and the others keep running. | FR-2, SR-1 |
| AC-12 | Given `engine.yaml` with `master:`, when `factory-engine start` runs from another folder, then it uses that master clone. | FR-16 |
| AC-13 | `project-file/1.0`, `factory-lease/1.0` and `engine-index/1.0` have JSON Schemas, and the project's life in the engine (found, needs setup, running, stopping, removed, refused) is a jssm machine with the F-019 dead-end test. | FR-2, FR-4, FR-7, FR-12 |

## 5. Constraints
- No new libraries. File checks reuse `paths-file.ts` (owner-only, size
  limit, no links, SDDL on Windows); the folder poll uses `fs.statSync`,
  not `fs.watch`, which is unreliable on Windows.
- The project file is YAML because the owner may write it by hand (F-020:
  hand-edited config stays YAML); its JSON Schema checks it all the same.
- Each project keeps its own channel, `engine.json` and sessions; the
  console reaches all projects by opening several of today's sessions.
- No limit on how many projects or features run at once (ADR 0007).
  Model plan limits are counted across all projects on the PC on purpose
  (F-013 FR-13): they are the owner's limits, not a project's.

## 6. Edge cases
- The project file's `name` differs from the manifest's: refused, with both
  names shown.
- Two project files name the same config repo or the same name: both are
  refused until one is removed.
- A feature needs two shared repos checked out, and another project holds
  one of them: the feature waits without holding the other, so two
  projects can't each hold one and wait on the other forever.
- A feature's spec is changed to add a repo it changes: the checkout is
  taken before the first change to that repo, as for any other.
- A project is copied to a second PC rather than moved, and both factories
  run: the lease (FR-7) lets only one serve it; the other shows "served by
  another factory".
- The old PC is gone and its lease is fresh: the owner takes it over
  through `confirm` (FR-7) rather than waiting 30 minutes.
- A project removed while an agent is mid-commit: the stop waits for the
  commit, then ends the session.
- Private detail of an open item stayed on the old PC: the console on the
  new PC says the detail is on the other PC; the item can still be
  answered here or on GitHub.
- An existing project whose features already skipped numbers keeps its
  ids; only new features take the next number in their own project.

## 7. Dependencies
- `engine/src/cli.ts`, `engine/src/engine.ts` (project start and stop,
  feature ids, status, the maps of FR-10), `engine/src/config/paths-file.ts`,
  `engine/src/config/confirm.ts`, `engine/src/config/pins.ts`,
  `engine/src/state/record.ts`, `engine/src/state/runs.ts`,
  `engine/src/inbox/local.ts`, `engine/src/terminal/interview.ts`,
  `engine/src/mcp/locate.ts`, `engine/src/mcp/operations.ts`.
- `plugins/software-factory/skills/onboard-repo/` (FR-6).
- F-015 v23 per-owner tokens (merged, PR #115) are used as they are. The
  "Onboard mesbot into the factory" thread is told before the build starts.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | One owner per PC, and the factory runs as the owner's OS user, so "one factory per PC" is enforced per OS user. | Owner, 2026-11-19 02:26Z (decision card) | Approved |
| A-2 | The engine folder is owner-only and not synced to a cloud drive (as F-021 A-2). | Owner, 2026-11-19 02:26Z (decision card) | Approved |

## 9. Security considerations
| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | A project file decides which config repo, and so which owner ids, the factory trusts, so it gets today's paths-file checks: regular file, no link, at most 64 KiB, owner-only (SDDL on Windows, uid and mode elsewhere), schema-valid. A failing file is refused whole and never partly applied. | Analyst (F-007 SR-13 carried over) | Approved (owner, 2026-11-19 02:26Z, decision card) |
| SR-2 | A project file adds no trust by itself: the project runs only after the SR-5 confirm with the GitHub device sign-in on this factory. Moving a project to a new factory always needs that confirm. | Analyst (F-007 SR-5) | Approved (owner, 2026-11-19 02:26Z, decision card) |
| SR-3 | The lease holds a random factory id and times, nothing about the PC, user or paths, since `factory/state` may be pushed to GitHub. | Analyst (owner rule 2026-11-12) | Approved (owner, 2026-11-19 02:26Z, decision card) |
| SR-4 | A token secret is read only for the project its name gives; a test fails if any code path passes one project's token to another's GitHub client (AC-10). | Analyst (F-015 SR-2) | Approved (owner, 2026-11-19 02:26Z, decision card) |
| SR-5 | The engine index is owner-only, holds names, paths and channel addresses only, and clients apply today's `engine.json` checks to it and still check each channel's pid. | Analyst (F-005 SR-1) | Approved (owner, 2026-11-19 02:26Z, decision card) |
| SR-7 | The checkout record in a code repo, which may be public, holds only the project name, feature id, a random factory id and times; nothing about the PC, user, paths or the config repo. | Analyst (owner rule 2026-11-12) | Approved (owner, 2026-11-19 02:26Z, decision card) |
| SR-6 | Agents may not write `projects/`, `engine.yaml` or the engine index: they join the Role policy's denied paths, so an agent can't give the factory a project. | Analyst (F-005 SR-14) | Approved (owner, 2026-11-19 02:26Z, decision card) |

## 10. Interface requirements
Change-controlled edits, one hygiene item each, applied with the build
after the owner approves their text:

| Id | File(s) | Change | Status |
|---|---|---|---|
| H-0257 | `docs/interface-contracts.md` (Engine control channel v1.7) | `engine.status` features gain `project`; `pause`/`resume` take optional `project` (non-breaking). New section for the engine index (`engine-index/1.0`). | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |
| H-0258 | `docs/interface-contracts.md` (new: Project file v1.0, Factory lease v1.0), `docs/architecture.md` § Data formats | Project file format, the lease on `factory/state`; replaces the paths file (H-0081) with the one-time import. | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |
| H-0259 | `docs/adr/0034-one-factory-portable-projects.md` (new), `docs/adr/README.md` | One factory per PC; a project is a file plus its config repo and moves with them; feature ids per project. | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |
| H-0260 | `docs/features/F-007-engine-interviews.md` (SR-16, OQ-10), `docs/features/F-016-*` and README text that says ids are unique across projects | SR-16 becomes: feature ids are unique within a project; the engine keys every feature by project and id. OQ-10 notes the owner's change of 2026-11-19. | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |
| H-0261 | `README.md`, `engine/README.md`, `plugins/software-factory/skills/onboard-repo/SKILL.md` | Describe project files, setup steps, moving a project, the all-projects console and `master:`; the onboarding skill's last step writes the project file. | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |
| H-0263 | `docs/interface-contracts.md` (new: Repo checkout v1.0) | The `factory/checkout` record and the `feature/<project>/F-nnn-<slug>` branch name in a repo more than one project uses. No manifest change. | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |
| H-0262 | `.gitignore`, Role policy denied paths, `scripts/check_placeholders.py` | Ignore `/projects/`; deny agents `projects/`, `engine.yaml` and the engine index; the "never tracked" CI check covers `projects/`. | Approved (owner, 2026-11-19 02:26Z, decision card); text drafted at build |

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit (A-1, A-2 approved)
- [ ] Blocking decisions resolved (spec sign-off; H-0257 to H-0263; Security and Testability Review not yet run)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-15 | Draft from the owner's request, after reading what the engine already does | — |
| 2 | 2026-11-19 | From the owner's messages 02:00Z and 02:04Z (a safety mechanism so two factories never write to the same project): one factory per PC (FR-1); a portable project file per project, moved between factories, with setup steps and a lease (FR-2 to FR-8); the onboarding skill or the owner gives the factory a project, so the `project add/remove` commands and the JSON registry go (old OQ-1 and OQ-2 closed); feature ids per project (FR-9, reverses F-007 SR-16 / OQ-10); every cross-project map keyed by project (FR-10); a repo is checked out only by a feature that changes it, with no configuration (FR-11, FR-11b, owner's messages 02:08Z and 02:19Z); overlapping changes settled by an Architecture decision filed in each project, joint only if every project's owner agrees (FR-11c, FR-11d, owner's message 02:22Z) | Owner's direction, 2026-11-19 02:00Z to 02:22Z (messages) |
| 3 | 2026-11-19 | Spec v2 signed off as written, with A-1, A-2, SR-1 to SR-7 and H-0257 to H-0263; status Approved | Owner, 2026-11-19 02:26Z (decision card) |
