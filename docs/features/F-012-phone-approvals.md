# Feature: Phone notifications and approvals for inbox items

- **Id:** F-012
- **Status:** Superseded by F-011 v29 (ADR 0022; owner, 2026-11-13). Nothing is built from this spec.
- **Requested by / date:** Alex, 2026-11-13 (split from F-011 OQ-3: "the phone
  notification needs to be tied to some way to do approvals on my phone also";
  "I want a confirmation on risky actions like a merge, not just one click")
- **Spec version:** 11 

> **Superseded.** ADR 0022 makes GitHub issues the only inbox store, so the
> phone no longer needs its own channel: every item is an issue, acted on the
> same way on the phone and the PC. F-011 v20 carries this spec's approved
> requirements: FR-2 to FR-8, FR-10, FR-11, FR-13, FR-14 as F-011 FR-1 to
> FR-8, FR-15, FR-20; SR-1 to SR-13 as F-011 SR-1 to SR-12; A-1, A-2 as F-011
> A-2, A-3. Withdrawn: FR-1's "blocking items only" (F-011 OQ-13), FR-9's
> phone-only wording (F-011 FR-9), H-0125 (folded into Inbox item v3.0,
> H-0165), H-0126 (revised as H-0162), H-0128 (no `phone` block needed).
> H-0129 (ADR 0018) stays applied. The text below is v10, kept for the record.

## 1. Objective and business purpose
The factory stalls whenever an item is waiting for the owner and the owner is
away from the PC. F-011 tells the owner about blocking items in VS Code and
with an OS notification, which only helps at the desk. The owner wants to be
told on the phone, and to act on the item from the phone, so a waiting
feature can move without a trip to the PC.

A notification alone isn't enough (owner, 2026-11-13): it must lead straight
to a way to approve, reject, answer or defer the item from the phone. Risky
actions, such as a merge, need a confirmation step, not a single tap (owner,
2026-11-13).

## 2. Expected behavior
The channel is a GitHub issue acted on with reactions (OQ-1, decided by the
owner 2026-11-13).

1. When a blocking item opens (any F-011 kind that needs the owner), the owner
   gets a push notification from the GitHub Mobile app: a new issue in the
   project's **private** config repo, titled with the item's kind, category
   and title, for example "Decision (Product): Which phone channel?".
2. The issue shows the same card as VS Code: what is being asked, the
   options and the recommendation, the evidence, and links to the PR or
   spec. Under it, one short comment per allowed action, for example
   "Approve", "Reject", "Option 2: ntfy", "Defer". Each kind gets only its
   F-011 actions.
3. **The owner acts by tapping, not typing** (owner, 2026-11-13: "phone is
   not a platform for typing, I'd prefer a button push"). Tapping 👍 on an
   action's comment chooses it. The engine (code, not an agent) sees the
   reaction, checks it was made by the owner's GitHub account on the
   current revision of the item, and records the action on `factory/state`
   exactly as a VS Code action would. A reply says what was recorded, and
   the issue closes.
4. **Risky actions ask for a confirmation** (owner, 2026-11-13). After 👍 on
   a risky action (FR-8), a new comment restates the exact action and
   target, for example "Confirm: approve hygiene change H-0130 to
   agents/developer/AGENT.md?", and the owner taps 🚀 on it. Nothing happens
   until that tap, within 15 minutes. No tap cancels it.
5. **Pull requests** are merged in GitHub Mobile itself: the issue links the
   PR, and the owner uses GitHub's own merge button, which already asks to
   confirm the merge. `main` needs only a PR and green CI (ADR 0017), so
   the owner can merge from the phone without a bypass. The engine sees the
   merge and closes the inbox item and the issue.
6. Notes are the one place typing is needed: "Request changes" and "Ask for
   more context" take a comment with the note. Everything else is a tap.
7. Acting in VS Code first closes the issue with a note saying so. A later
   tap on a closed issue does nothing.

No new app, account or service is needed beyond GitHub Mobile, which the
owner already uses for the interview device approval (ADR 0014).

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | When a blocking item opens, a phone issue for it is opened in the project's config repo within one engine poll, if phone notifications are on for the project (FR-11). |
| FR-2 | The issue is opened by a workflow in the config repo running as `github-actions[bot]`, so GitHub notifies the owner; GitHub doesn't notify people about their own activity, and the engine acts as the owner (ADR 0017). The issue body @mentions the owner's login, taken from the config repo, never the master repo. |
| FR-3 | The issue body is rendered by code from the item, using one fixed template per kind (H-0125): kind, category, title, priority, the question or change, options with numbers and the recommendation, evidence and links, and the item revision. The workflow then posts one action comment per allowed action for that revision, each with a fixed label. Owner-facing text only; no agent writes free text into it. |
| FR-4 | The engine reads reactions on the action comments of open phone issues every poll. It acts only on a 👍 whose user id equals the owner's (engine config), on an action comment of the item's current revision. Reactions by anyone else, other emoji, and reactions on stale action comments change nothing; the engine replies "not recorded: <reason>" once for a stale one. Two 👍 on different actions of one revision: nothing is recorded and the engine asks to pick one. |
| FR-5 | A valid tap becomes one owner-action commit on `factory/state`, with the same fields as a VS Code action plus `via: phone` and `ref: <action comment URL>` (F-011 H-0120). The engine then acts on it exactly as F-011 FR-5 says. |
| FR-6 | After recording, the engine replies with what it recorded, and closes the issue. If the item is acted on elsewhere first, the engine closes the issue with "acted on in VS Code". |
| FR-7 | If the item changes (new revision) while its issue is open, the engine edits the issue body to the new revision, marks the old action comments stale, and the workflow posts new ones; taps on stale comments are refused (FR-4). |
| FR-8 | Risky actions need a confirmation step (owner, 2026-11-13). Risky means the actions F-011 FR-15 asks to confirm in VS Code (owner, 2026-11-13: Approve and merge; Approve on Hygiene, Maturity, Security decision and Spec sign-off items); the phone uses the same list. For these, the 👍 records nothing; the engine posts a confirm comment restating the exact action and target (for a hygiene change, the files; for a maturity change, the repo and levels; for a Security decision, the option and the risk it accepts; for a spec sign-off, the feature and spec version). Only a 🚀 by the owner on that comment, within 15 minutes, while the item is still at that revision, records the action. A PR merge is confirmed by GitHub's own merge dialog (FR-9). |
| FR-9 | Pull request items are not merged by a reaction. The issue links the PR and says to merge in GitHub Mobile. When the engine sees the PR merged by the owner's account, it closes the item (`merged_on_github`) and the issue. Request changes and Defer work as for other kinds. |
| FR-10 | Decision items get one action comment per option, plus Defer. Request changes, Ask for more context (goes back to the agent that filed it) and a free-text answer, where the item allows one, are taken from a comment by the owner whose first line is the action's name, then the note. These are the only typed actions. Agents never answer for the owner; a deferred item stays open with no default (owner rule, 2026-11-10). |
| FR-11 | Phone notifications are off until the owner turns them on per project. Turning them on checks that the config repo is private and that the workflow is installed; it refuses with the reason if either is not. Owner-specific values (login, user id) live in the config repo and the owner's engine config, never in the master repo. |
| FR-13 | Phone issues carry the label `factory-inbox` and are excluded from F-010 issue triage. |
| FR-14 | All of this is code: the engine and the workflow. No agent reads phone comments or writes phone issues (owner rule, 2026-11-13: tools, not tokens). |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given phone notifications on and a new blocking item, then within one engine poll a phone issue opened by `github-actions[bot]` exists in the config repo, with the `factory-inbox` label and an @mention of the owner. | FR-1, FR-2, FR-13 |
| AC-2 | Given one item of each kind, then each issue body matches its kind's template and has exactly one action comment for each action F-011 FR-3 allows for that kind. | FR-3 |
| AC-3 | Given 👍 from the owner on a non-risky item's action comment at the current revision, then exactly one owner-action commit with `via: phone` and the action comment URL is on `factory/state`, the reply names the action, and the issue is closed. | FR-4, FR-5, FR-6 |
| AC-4 | Given 👍 from another account, another emoji from the owner, 👍 on a stale action comment, or 👍 on two actions, then nothing is recorded; the stale and two-action cases get a reply giving the reason. | FR-4, FR-7 |
| AC-5 | Given 👍 on a risky action, then nothing is recorded and a confirm comment names the exact action and target; given 🚀 from the owner on it within 15 minutes, then the action is recorded; given 🚀 after 15 minutes, from another account, or after the item changed, then nothing is recorded. | FR-8 |
| AC-6 | Given a PR item, then no reaction merges it; given the owner merges it in GitHub, then the item closes as `merged_on_github` and the issue closes. | FR-9 |
| AC-7 | Given the item acted on in VS Code while its issue is open, then the issue closes with "acted on in VS Code" and a later tap records nothing. | FR-6 |
| AC-8 | Given a public config repo or a missing workflow, when the owner turns phone notifications on, then it refuses with the reason. | FR-11 |
| AC-10 | Given a phone issue, then F-010 triage doesn't snapshot it. | FR-13 |
| AC-11 | Given 👍 on Defer for a Decision, then the item stays open with no answer recorded. | FR-10 |

## 5. Constraints
- TypeScript in the engine; the issue-opening workflow is a GitHub Actions
  workflow in each project's config repo, shipped as a template in the master
  repo and installed by onboarding (F-003).
- The config repo must be private (FR-11). Item text goes only there.
- No owner-specific value in the master repo (owner rule, 2026-11-11).
- No new external service or account (OQ-1 a).
- Security controls cite their source (owner, 2026-11-13); usability wins
  where no standard asks for more.
- Works whatever the owner's PC OS is; the phone side is any phone that runs
  GitHub Mobile.

## 6. Edge cases
- PC off or engine stopped: no new issues open (items are only made by the
  engine), and taps wait; the engine processes them when it starts, and a
  🚀 on a confirm comment older than 15 minutes is refused, so the owner
  taps again.
- Owner removes a 👍 before the engine's poll: nothing is recorded. After
  the poll, the action stands; undoing it is a new item, as in VS Code.
- Owner taps 👍 on two actions: nothing is recorded (FR-4).
- Owner deletes or closes the issue by hand: the item stays open in VS Code;
  the engine doesn't reopen the issue.
- The workflow fails or Actions is down: the engine sees no issue after two
  polls and files a Notice in VS Code; it doesn't retry in a loop.
- Many items at once: one issue each; the owner's GitHub notification
  settings decide grouping.
- Abuse: a collaborator on the config repo reacts 👍 or 🚀 (refused, FR-4);
  text in an item tries to look like an action comment (the body is a
  template with escaped fields, FR-3, and only the workflow's action
  comments count).

## 7. Dependencies
- F-011: item kinds, actions, the shared risky-action list, `factory/state`
  action commits, and the PR item.
- Engine increment 3 (acting on answers).
- F-003 onboarding, to install the config repo workflow and check privacy.
- F-010: must skip `factory-inbox` issues.
- ADR 0017 (owner's account, `main` without required review).

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | GitHub Mobile sends a push for an issue opened by `github-actions[bot]` that @mentions the owner in a repo they watch. To be checked in a spike before build. | OQ-1 | Approved (owner, 2026-11-13, decision card) |
| A-2 | GitHub's merge confirm step in GitHub Mobile counts as the confirmation for a merge (FR-8, FR-9). | OQ-1 | Approved (owner, 2026-11-13, decision card) |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | External service (S9.1): GitHub only. Workflow, as `github-actions[bot]`, in the config repo: create issue, add label, create comment. Engine, with the owner's token: list issue comments, list reactions on them, create comment, update its own comments (to mark them stale), update issue body, close issue, read PR state, read the config repo's visibility and collaborators (SR-9), send `repository_dispatch` to the config repo. No other call. | Analyst (S9.1) | Accepted (owner, 2026-11-13, decision card) |
| SR-2 | The owner is proven by GitHub: a reaction counts only if its user id is the owner's. It is recorded with the action comment URL instead of an SSH signature, which a phone can't make (ADR 0018, amending ADR 0015 decision 3 for phone actions). | Analyst (S8, ADR 0015) | Accepted (owner, 2026-11-13, OQ-2) |
| SR-3 | Risky actions need a second, explicit tap on a comment that names the exact action and target, bound to the item revision, with a 15-minute expiry (owner, 2026-11-13; OWASP LLM Top 10 2025, LLM06: human approval for high-impact actions). | Owner, analyst | Accepted (owner, 2026-11-13, decision card) |
| SR-4 | Actions are read by code from reactions and fixed action names; comment text is never given to an agent as instructions (S9.3). Request changes and Ask notes go to agents as data, as other owner notes do. | Analyst (S9.3) | Accepted (owner, 2026-11-13, decision card) |
| SR-5 | Item content goes only to the private config repo, never to a public repo or a third-party service (owner rule, 2026-11-12: sensitive info never in a public repo). This replaces F-011's draft rule that phone alerts carry only counts: the phone has to show enough to decide, and the config repo is as private as the rest of the project. | Analyst | Accepted (owner, 2026-11-13, decision card) |
| SR-6 | Residual risk, to state to the owner: anyone holding the owner's GitHub session or token can comment as the owner, so a stolen phone with GitHub signed in, or the engine's token used by something else, could approve items. The confirm tap doesn't stop that; it guards against a mis-tap, not a stolen account. GitHub's own sign-in and 2FA are the control. Agents can't: they run in containers without tokens (ADR 0015). | Analyst | Stated to the owner and accepted 2026-11-13 (OQ-2) |
| SR-7 | No secrets or tokens in issue bodies, comments or logs (S3.1); the item's text passes the secrets scan before it is rendered. | Analyst (S3.1) | Accepted (owner, 2026-11-13, decision card) |
| SR-8 | The engine stores each action comment's id and text hash, and the issue body's hash, when posted; a tap on an edited action or confirm comment, or on an issue whose body was edited by anyone but the engine, records nothing. | Gate 1 #1 (S2.1, S6.2) | Accepted (owner, 2026-11-13, decision card) |
| SR-9 | Turning phone notifications on also checks that the owner is the config repo's only collaborator; otherwise it refuses and says why. | Gate 1 #2 (S8.1, owner rule 2026-11-12) | Accepted (owner, 2026-11-13, decision card) |
| SR-10 | Fields that can carry outside text are rendered in fenced code blocks, with @mentions and remote images stripped, under an engine-written line naming their author. | Gate 1 #3 (S6.1, S9.3) | Accepted (owner, 2026-11-13, decision card) |
| SR-11 | A CI test fails if engine code calls GitHub's create-reaction endpoint (REST or GraphQL `addReaction`); the engine only reads reactions. | Gate 1 #4 (S2.1, LLM06) | Accepted (owner, 2026-11-13, decision card) |
| SR-12 | The config repo workflow has `permissions: issues: write` only, actions pinned by SHA, and runs only on `repository_dispatch` from the engine, executing nothing from the payload. | Gate 1 #5 (S4, S8.2) | Accepted (owner, 2026-11-13, decision card) |
| SR-13 | A phone history entry also records the reacting user id, reaction id and time, so it stands if the issue is deleted. | Gate 1 #6 (S3.3) | Accepted (owner, 2026-11-13, decision card) |

## 10. Interface requirements
Approved by the owner 2026-11-13 (decision card). H-0127 is withdrawn
(folded into F-011's H-0120).

### H-0125 (approved, owner, 2026-11-13, decision card, Interfaces): Phone issue v1.0, and Inbox item v2.1
**Phone issue v1.0** (new contract; the engine renders, the config repo
workflow posts):

- **Where:** the project's config repo, which must be private and have the
  owner as its only collaborator (FR-11, SR-9). Label `factory-inbox`.
- **Title:** `<Kind>[ (<Category>)]: <item title>`, at most 120 characters,
  for example `Decision (Product): Which phone channel?`.
- **Body:** a hidden marker line
  `<!-- factory-item: <repo>/<item id> rev <n> -->`; then the card
  sections of the item's kind from Inbox item v2.0, rendered by code under
  SR-10 (outside text fenced, @mentions and remote images stripped, author
  line above it); then a line giving the item's revision; last, an
  @mention of the owner's login, read from the config repo.
- **Action comments:** one per allowed action for the kind (F-011 FR-3),
  posted by the workflow in a fixed order, each a single line:
  `<label>`, for example `Approve`, `Reject`, `Defer`, `Option 2: ntfy`.
  The engine keeps the comment id, label, revision and text hash (SR-8).
  Request changes and Ask for more context get a comment that reads
  `<label>: reply with a comment starting "<label>:" and your note`.
- **Reactions:** 👍 (`+1`) on an action comment chooses it; 🚀 (`rocket`)
  on a confirm comment confirms a risky action (FR-8). Any other reaction
  is ignored.
- **Confirm comment** (engine): `Confirm: <action> <target>. Tap 🚀 within
  15 minutes.` The target is fixed per kind: hygiene, the item id and files;
  maturity, the repo and from and to levels; Security decision, the option
  and the risk it accepts; spec sign-off, the feature and spec version.
- **Replies** (engine), fixed texts: `Recorded: <action>.`,
  `Not recorded: <reason>.` (reasons: changed since, two actions chosen,
  confirm expired, comment edited), `Acted on in VS Code.`,
  `Merged on GitHub.`
- **Close:** the engine closes the issue after recording, or when the item
  closes elsewhere.

**Inbox item v2.1** (minor): a history entry with `via: phone` also has
`ref` (action comment URL), `reaction_id`, `actor_id` (the reacting
GitHub user id) and `read_at` (SR-13). Such an entry needs no signature
(ADR 0018); every other non-PR owner action keeps ADR 0015 signing. A
`merged_on_github` action closes a `pull_request` item when the engine sees
the PR merged by the owner's account (FR-9).

### H-0126 (approved, owner, 2026-11-13, decision card, Hygiene): config repo workflow template
- The master repo ships `templates/config-repo/.github/workflows/factory-inbox.yml`.
  F-003 onboarding copies it into the config repo when the owner turns
  phone notifications on, and checks the repo is private and owner-only.
- `on: repository_dispatch` with type `factory-inbox` only;
  `permissions: issues: write`; actions pinned by commit SHA (SR-12).
- It creates the issue from the engine's rendered title and body, adds the
  label, and posts the action comments in order. It runs nothing from the
  payload and makes no other call.
- The engine sends the dispatch with the owner's token; the payload holds
  only the rendered title, body, action labels and the item reference.

### H-0128 (approved, owner, 2026-11-13, decision card, Interfaces): Project manifest v1.7 `phone` block
(v1.6 is F-011's H-0124.) New optional top-level key:

```yaml
phone:
  enabled: false   # true sends blocking items to the config repo as phone issues
```

- Absent means `enabled: false`.
- The owner's GitHub login and user id are not in the manifest: the login
  for the @mention is a repository variable of the config repo
  (`FACTORY_OWNER_LOGIN`), and the user id the engine checks is in the
  engine's own config, outside Git.
- `enabled` is a pinned key (F-007 SR-5): turning it on needs the owner's
  confirmation and passes the FR-11 checks first.

### H-0129 (approved with OQ-2, applied in this PR): ADR 0018
ADR 0018 added, amending ADR 0015 decision 3 for phone actions; its row in
`docs/adr/README.md`; ADR 0015's header notes the amendment.

## 11. Readiness gate
Checked 2026-11-13 against spec v10.

- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit (A-1, A-2 approved; A-1 checked in a spike before build)
- [x] Blocking decisions resolved (OQ-1 to OQ-4 decided; SR-1 to SR-13, H-0125, H-0126, H-0128 approved; H-0129 applied)

Follow-up outside this spec: F-010 needs a matching amendment so triage
skips `factory-inbox` issues (FR-13) before either feature's build.

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft with open questions OQ-1 to OQ-4; includes the owner's confirmation rule for risky actions | — |
| 2 | 2026-11-13 | Owner: phone actions are taps, not typing. OQ-1 decided (a): GitHub issue, 👍 on an action comment, 🚀 to confirm risky actions; risky list follows F-011 FR-15; H-0127 folded into F-011 H-0120 | Owner, 2026-11-13 (thread, decision card) |
| 3 | 2026-11-13 | OQ-3 decided with F-011 FR-15: the confirm list adds Security decisions and Spec sign-off | Owner, 2026-11-13 (decision card, F-011 thread) |
| 4 | 2026-11-13 | OQ-2 decided: a tap from the owner's GitHub account proves a phone action (ADR 0018); SR-6 risk accepted | Owner, 2026-11-13 (decision card) |
| 5 | 2026-11-13 | OQ-4 decided: no quiet hours in this feature (FR-12, AC-9 removed) | Owner, 2026-11-13 (decision card) |
| 6 | 2026-11-13 | Security Gate 1: 6 findings, none blocking; SR-8 to SR-13 proposed | — |
| 7 | 2026-11-13 | SR-8 to SR-13 approved | Owner, 2026-11-13 (decision card) |
| 8 | 2026-11-13 | A-1 and A-2 approved; A-1 checked in a spike before build, and a failed check sends the spec back to the owner | Owner, 2026-11-13 (decision card) |
| 9 | 2026-11-13 | SR-1, SR-3, SR-4, SR-5, SR-7 approved; section 10: drafts of H-0125, H-0126, H-0128; H-0129 applied | Owner, 2026-11-13 (decision card) for the SRs |
| 10 | 2026-11-13 | H-0125, H-0126, H-0128 approved; readiness gate passed | Owner, 2026-11-13 (decision card) |
| 10 | 2026-11-13 | Spec v10 signed off; status Approved | Owner, 2026-11-13 (decision card) |
| 11 | 2026-11-13 | Superseded by F-011 v20 for ADR 0022 (proposal 0026); requirements carried or withdrawn as listed at the top | Owner, 2026-11-13 (F-011 v29 sign-off, decision card) |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | How does the phone get notified and act? The owner asked for taps, not typing. (a) GitHub issue per item in the private config repo, push from GitHub Mobile, tap 👍 on an action comment and 🚀 to confirm risky ones, merge PRs in GitHub Mobile. (b) ntfy notification buttons; item text and a secret pass through ntfy. (c) A phone web page from the engine over Tailscale. | Architecture | Decided (owner, 2026-11-13, decision card): (a) |
| OQ-2 | ADR 0015 says an owner action counts only if signed with the owner's SSH key, which a phone can't do. Accept a tap from the owner's GitHub account as proof for phone actions, accepting SR-6? | Security | Decided (owner, 2026-11-13, decision card): yes; ADR 0018 |
| OQ-3 | Which actions count as risky and need the confirm step? | Product | Decided (owner, 2026-11-13, F-011 FR-15 card): Approve and merge; Approve on Hygiene, Maturity, Security decision and Spec sign-off items |
| OQ-4 | Quiet hours: in this feature or later? | Product | Decided (owner, 2026-11-13, decision card): later; the phone's do-not-disturb covers it for now |
