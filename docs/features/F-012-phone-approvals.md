# Feature: Phone notifications and approvals for inbox items

- **Id:** F-012
- **Status:** Draft
- **Requested by / date:** Alex, 2026-11-13 (split from F-011 OQ-3: "the phone
  notification needs to be tied to some way to do approvals on my phone also";
  "I want a confirmation on risky actions like a merge, not just one click")
- **Spec version:** 1

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
This section describes the recommended channel (OQ-1 a). Section 13 lists the
alternatives.

1. When a blocking item opens (any F-011 kind that needs the owner), the owner
   gets a push notification from the GitHub Mobile app: a new issue in the
   project's **private** config repo, titled with the item's kind, category
   and title, for example "Decision (Product): Which phone channel?".
2. The issue shows the same card as VS Code: what is being asked, the
   options and the recommendation, the evidence, links to the PR or spec,
   and the allowed actions written as short commands, for example
   `/approve`, `/reject`, `/choose 2`, `/defer`, `/changes <note>`,
   `/ask <question>`. Each kind allows only its F-011 actions.
3. The owner replies with a comment. The engine (code, not an agent) reads
   the comment, checks it was written by the owner's GitHub account and that
   the item hasn't changed since, and records the action on `factory/state`
   exactly as a VS Code action would. The issue gets a reply saying what was
   recorded, and closes.
4. **Risky actions ask for a confirmation** (owner, 2026-11-13). After
   `/approve` on a risky item (section 3, FR-8), the reply restates the exact
   action and target and asks for `/confirm <code>`, where the code is short
   and shown only in that reply. Nothing happens until the owner confirms
   within 15 minutes. Any other reply, or no reply, cancels it.
5. **Pull requests** are merged in GitHub Mobile itself, not by a comment:
   the issue links the PR, and the owner uses GitHub's own merge button,
   which already asks to confirm the merge. `main` needs only a PR and green
   CI (ADR 0017), so the owner can merge from the phone without a bypass.
   The engine sees the merge and closes the inbox item and the issue.
   `/changes <note>` on the issue routes review feedback as in F-011.
6. Acting in VS Code first closes the issue with a note saying so. A later
   comment on a closed issue does nothing.

No new app, account or service is needed beyond GitHub Mobile, which the
owner already uses for the interview device approval (ADR 0014).

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | When a blocking item opens, a phone issue for it is opened in the project's config repo within one engine poll, if phone notifications are on for the project (FR-11). |
| FR-2 | The issue is opened by a workflow in the config repo running as `github-actions[bot]`, so GitHub notifies the owner; GitHub doesn't notify people about their own activity, and the engine acts as the owner (ADR 0017). The issue body @mentions the owner's login, taken from the config repo, never the master repo. |
| FR-3 | The issue body is rendered by code from the item, using one fixed template per kind (H-0125): kind, category, title, priority, the question or change, options with numbers and the recommendation, evidence and links, the item revision, and the allowed commands. Owner-facing text only; no agent writes free text into it. |
| FR-4 | The engine reads new comments on open phone issues every poll. It acts only on a comment whose author's GitHub user id equals the owner's (engine config), whose first line is a command allowed for the item's kind, and whose item revision equals the revision in the issue. Anything else gets a fixed "not recorded: <reason>" reply and changes nothing. |
| FR-5 | A valid command becomes one owner-action commit on `factory/state`, with the same fields as a VS Code action plus `via: phone` and the comment URL (H-0127). The engine then acts on it exactly as F-011 FR-5 says. |
| FR-6 | After recording, the engine replies with what it recorded, and closes the issue. If the item is acted on elsewhere first, the engine closes the issue with "acted on in VS Code". |
| FR-7 | If the item changes (new revision) while its issue is open, the engine edits the issue body to the new revision and replies "changed, read again"; commands naming the old revision are refused (FR-4). |
| FR-8 | Risky actions need a confirmation step (owner, 2026-11-13). Risky means the actions F-011 FR-15 asks to confirm in VS Code (today: merging a PR, approving a hygiene change, approving a maturity change); the phone uses the same list. For these, the first command records nothing; the reply restates action and target and asks for `/confirm <code>` with a one-time 6-character code. Only that code, from the owner, within 15 minutes, on the same item revision, records the action. |
| FR-9 | Pull request items are not merged by a phone command. The issue links the PR and says to merge in GitHub Mobile. When the engine sees the PR merged by the owner's account, it closes the item (`merged_on_github`) and the issue. `/changes <note>` and `/defer` work as for other kinds. |
| FR-10 | Decision items accept `/choose <n>`, `/answer <text>` where the item allows free text, `/ask <question>` (ask for more context, which goes back to the agent that filed it), and `/defer`. Agents never answer for the owner; a deferred item stays open with no default (owner rule, 2026-11-10). |
| FR-11 | Phone notifications are off until the owner turns them on per project. Turning them on checks that the config repo is private and that the workflow is installed; it refuses with the reason if either is not. Owner-specific values (login, user id) live in the config repo and the owner's engine config, never in the master repo. |
| FR-12 | Quiet hours: optional, set by the owner in the config repo. During them, issues still open but the body skips the @mention, so GitHub only sends a watch notification (subject to the owner's GitHub settings). |
| FR-13 | Phone issues carry the label `factory-inbox` and are excluded from F-010 issue triage. |
| FR-14 | All of this is code: the engine and the workflow. No agent reads phone comments or writes phone issues (owner rule, 2026-11-13: tools, not tokens). |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given phone notifications on and a new blocking item, then within one engine poll a phone issue opened by `github-actions[bot]` exists in the config repo, with the `factory-inbox` label and an @mention of the owner. | FR-1, FR-2, FR-13 |
| AC-2 | Given one item of each kind, then each issue body matches its kind's template and lists exactly the commands F-011 FR-3 allows for that kind. | FR-3 |
| AC-3 | Given `/approve` from the owner on a non-risky item at the current revision, then exactly one owner-action commit with `via: phone` and the comment URL is on `factory/state`, the reply names the action, and the issue is closed. | FR-4, FR-5, FR-6 |
| AC-4 | Given the same command from another account, from the owner with an unknown command, or naming an old revision, then nothing is recorded and a "not recorded" reply gives the reason. | FR-4, FR-7 |
| AC-5 | Given `/approve` on a risky item, then nothing is recorded and a reply asks for `/confirm <code>`; given the right code from the owner within 15 minutes, then the action is recorded; given a wrong code, a late code, another account's code, or a code after the item changed, then nothing is recorded. | FR-8 |
| AC-6 | Given a PR item, then no command merges it; given the owner merges it in GitHub, then the item closes as `merged_on_github` and the issue closes. | FR-9 |
| AC-7 | Given the item acted on in VS Code while its issue is open, then the issue closes with "acted on in VS Code" and a later phone command records nothing. | FR-6 |
| AC-8 | Given a public config repo or a missing workflow, when the owner turns phone notifications on, then it refuses with the reason. | FR-11 |
| AC-9 | Given quiet hours and a new item inside them, then the issue opens without an @mention. | FR-12 |
| AC-10 | Given a phone issue, then F-010 triage doesn't snapshot it. | FR-13 |
| AC-11 | Given `/defer` on a Decision, then the item stays open with no answer recorded. | FR-10 |

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
  engine), and comments wait; the engine processes them in order when it
  starts, and a `/confirm` that is now older than 15 minutes is refused.
- Owner edits a comment after posting: the engine uses the text at the time
  it reads it and ignores later edits; a comment already recorded isn't
  re-read.
- Two commands in one comment: only the first line counts.
- Owner deletes or closes the issue by hand: the item stays open in VS Code;
  the engine doesn't reopen the issue.
- The workflow fails or Actions is down: the engine sees no issue after two
  polls and files a Notice in VS Code; it doesn't retry in a loop.
- Many items at once: one issue each; the owner's GitHub notification
  settings decide grouping.
- Abuse: a collaborator on the config repo comments `/approve` (refused, FR-4);
  someone copies a confirm code from the reply (they would need the owner's
  account to post it); text in an item tries to inject a command into the
  issue body (the body is a template with escaped fields, FR-3, and only
  comments are read as commands).

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
| A-1 | GitHub Mobile sends a push for an issue opened by `github-actions[bot]` that @mentions the owner in a repo they watch. To be checked in a spike before build. | OQ-1 | Pending |
| A-2 | GitHub's merge confirm step in GitHub Mobile counts as the confirmation for a merge (FR-8, FR-9). | OQ-1 | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | External service (S9.1): GitHub only. Workflow, as `github-actions[bot]`, in the config repo: create issue, add label. Engine, with the owner's token: list issue comments, create comment, update issue body, close issue, read PR state. No other call. | Analyst (S9.1) | Proposed |
| SR-2 | The owner is proven by GitHub: a comment counts only if its author's user id is the owner's. It is recorded with the comment URL instead of an SSH signature, which a phone can't make. This amends ADR 0015 decision 3 for phone actions (OQ-2). | Analyst (S8, ADR 0015) | Proposed, needs OQ-2 |
| SR-3 | Risky actions need a second, explicit step with a one-time code bound to the item revision and a 15-minute expiry (owner, 2026-11-13; OWASP LLM Top 10 2025, LLM06: human approval for high-impact actions). | Owner, analyst | Proposed |
| SR-4 | Commands are parsed by code from a fixed grammar; comment text is never given to an agent as instructions (S9.3). `/ask` and `/changes` text goes to agents as data, as other owner notes do. | Analyst (S9.3) | Proposed |
| SR-5 | Item content goes only to the private config repo, never to a public repo or a third-party service (owner rule, 2026-11-12: sensitive info never in a public repo). This replaces F-011's draft rule that phone alerts carry only counts: the phone has to show enough to decide, and the config repo is as private as the rest of the project. | Analyst | Proposed |
| SR-6 | Residual risk, to state to the owner: anyone holding the owner's GitHub session or token can comment as the owner, so a stolen phone with GitHub signed in, or the engine's token used by something else, could approve items. The confirm code doesn't stop that, because it's shown in the same issue. GitHub's own sign-in and 2FA are the control. Agents can't: they run in containers without tokens (ADR 0015). | Analyst | To state with OQ-2 |
| SR-7 | No secrets or tokens in issue bodies, comments or logs (S3.1); the item's text passes the secrets scan before it is rendered. | Analyst (S3.1) | Proposed |

## 10. Interface requirements
Hygiene items named here; none filed until the open questions are answered.

- **H-0125 (Interfaces): Phone issue v1.0.** Title format, body template per
  kind, label, the command grammar (`/approve`, `/reject`, `/choose <n>`,
  `/answer`, `/ask`, `/changes`, `/defer`, `/confirm <code>`), and reply
  texts.
- **H-0126 (Hygiene): config repo workflow template** and the F-003
  onboarding step that installs it and checks the repo is private.
- **H-0127 (Interfaces): owner action `via` and `ref` fields** on the inbox
  item history (`via: vscode | phone`, `ref: <comment URL>`). To fold into
  F-011's H-0120 (Inbox item v2.0) if that lands first.
- **H-0128 (Interfaces): Project manifest `phone` block** (`enabled`,
  `quiet_hours`); owner login and id stay in the config repo and engine
  config.
- **H-0129 (Architecture):** ADR amending ADR 0015 decision 3 for phone
  actions, if OQ-2 is decided that way.

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft with open questions OQ-1 to OQ-4; includes the owner's confirmation rule for risky actions | — |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | How does the phone get notified and act? (a) A GitHub issue per blocking item in the private config repo, push from GitHub Mobile, act by comment commands, merge PRs in GitHub Mobile. No new service; item text stays in a private repo; GitHub proves it's the owner. Costs typing a short command. (b) ntfy push with Approve/Reject buttons on the notification; the engine listens on a reply topic. Fastest to tap, but item text passes through ntfy's servers (or a self-hosted one), a tap is proven only by a secret in the button, the ntfy app and topic need setting up, and PRs still merge in GitHub. (c) Notification only (ntfy or email, counts only); PRs merged in GitHub Mobile, everything else waits for VS Code. Doesn't meet the ask. Recommended: (a). | Architecture | Open |
| OQ-2 | ADR 0015 says an owner action counts only if signed with the owner's SSH key, which a phone can't do. Accept a GitHub comment from the owner's account (checked by user id, URL recorded) as proof for phone actions? (a) Yes, amend ADR 0015 for phone actions (SR-2), accepting SR-6. (b) No: phone actions are recorded as pending and need a signed confirm in VS Code. Recommended: (a); (b) means nothing finishes from the phone. | Security | Open |
| OQ-3 | Which actions count as risky and need the confirm step? F-011 FR-15 owns the list (merge, hygiene approve, maturity approve); F-012 uses the same one. Whether to add Security risk acceptance and spec sign-off is for F-011. | Product | Follows F-011 FR-15 |
| OQ-4 | Quiet hours (FR-12): needed now, or later? Recommended: now, it's small. | Product | Open |
