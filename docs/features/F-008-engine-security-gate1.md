# Feature: Run Security Gate 1 on the real engine

- **Id:** F-008
- **Status:** Draft
- **Requested by / date:** Alex, 2026-11-12
- **Spec version:** 1

This is part of the engine's increment 3 ("Requirements to ready", F-007
section 13). OQ-1 asks the owner whether Security Gate 1 is built on its own
first, with reading inbox decisions under signed owner actions (ADR 0015)
and the full readiness gate as the next feature. This draft is written for
that recommended scope; if the owner chooses otherwise, it is widened.

## 1. Objective and business purpose
The engine now takes a feature from request to a spec that passes the
interview checks, then parks it at `security_gate_1` because nothing runs
the security reviewer. F-002 in the end-to-end trial project is parked there
now. Every feature needs Gate 1 before the readiness gate, so nothing can
move further until the engine runs it.

This feature makes the engine run Security Gate 1 for real: the security
reviewer, in its own container, reviews the spec against the factory's
security standards, and the engine records the report, sends the findings
where they belong, and moves the feature to the readiness gate once the
approved security requirements are in the spec.

## 2. Expected behavior
1. A feature reaches `security_gate_1` when its spec passes the interview
   checks, or is found there when the engine starts. Its project is enabled
   and running, so the gate starts with no approval per run (ADR 0012).
2. The engine starts the security reviewer as an Agent SDK session in its
   own container, on the feature branch's commit that passed the interview
   checks. The reviewer can read the worktree and nothing else: no writes,
   no shell, no network apart from the model API.
3. The reviewer gets its `AGENT.md`, the shared `security-review` skill and
   the factory's security standards from the factory version the project
   pins, plus the project's own security additions (OQ-4). It follows the
   Gate 1 checklist and returns its report through engine tools (OQ-2).
4. The engine checks the report, writes it on the feature branch as the
   agent report and as `docs/features/<feature>-security-gate1.md`, runs the
   secrets scan and commits.
5. If there are no findings, the feature moves to `readiness_gate`.
6. Findings the reviewer resolves with a new or tightened security
   requirement go back to the requirements analyst, who puts them to the
   owner (OQ-3). Findings that need the owner's choice between options are
   filed as Security items in the decision inbox, and the feature waits
   (`blocked`) until they are decided (OQ-3).
7. Once every finding is resolved by an approved requirement in the spec,
   and the spec passes the interview checks again, the feature moves to
   `readiness_gate`. The full readiness gate and reading inbox decisions
   come in the next feature (OQ-1).
8. `engine.status` shows the feature's stage throughout, and the transcript
   and engine log say why a gate didn't run or didn't finish.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | When a feature of an enabled, running project is at `security_gate_1` with no Gate 1 run for its current spec commit, the engine starts one. This happens after the interview checks pass and at engine start. One Gate 1 run per feature at a time. |
| FR-2 | The reviewer runs as an Agent SDK session in its own container under the project's `security-reviewer` role policy and every container rule of Role policy v2.5. The worktree is mounted read-only. |
| FR-3 | The engine gives the reviewer: its `AGENT.md` and the `security-review` skill as the analyst gets its own (F-007), the security standards from the pinned factory version and the project's additions (OQ-4), the feature's spec path and version, and the feature's interview transcript as data. |
| FR-4 | The reviewer returns its findings through engine tools (OQ-2). Each finding has criterion id, severity, location, explanation, suggested resolution and whether it needs the owner's choice. The report also answers each Gate 1 checklist question, lists the permissions the feature adds (S8.5), the abuse cases, and what is not applicable with the reason. |
| FR-5 | The engine validates the report: known criterion ids from the standards it gave, known severities, every checklist question answered, text within caps. An invalid report is refused back to the reviewer with the reason, within the session's turn cap. |
| FR-6 | The engine writes the Agent report v1.2 (`security-reviewer` body: `gate` 1, `findings`) and renders `docs/features/<feature>-security-gate1.md` in the layout the factory's existing Gate 1 reports use, then scans and commits them on the feature branch (ADR 0012). |
| FR-7 | A report with no findings moves the feature to `readiness_gate`. |
| FR-8 | Findings handled per OQ-3: each finding is either sent to the requirements analyst as a requirement to put to the owner, or filed as a Security item in the decision inbox with the reviewer's options and recommendation. A feature with any open Security item from its Gate 1 is `blocked`. |
| FR-9 | Before moving to `readiness_gate` after findings, the engine checks every finding is resolved: a security requirement in the spec's section 9 that cites the finding, with status Approved, or a decided Security item. A finding that isn't resolved keeps the feature at `security_gate_1` and the check's evidence names it. |
| FR-10 | Gate 1 runs are resumable and interruptible as analyst runs are (FR-14 of F-007, with the restart-recovery fix), within `MAX_RESUMES`. A run that fails is recorded in the transcript, the engine log and the agent report, with the reason. |
| FR-11 | The reviewer's model and session limits come from the master's `engine/config/models.yaml` and `engine/config/limits.yaml` at the pinned factory version, through hygiene item H-0095; the engine has no defaults. A project's `limits:` may only lower them. |
| FR-12 | `engine.status` reports the feature's stage at every step; the stage is recorded on the feature's transcript chain as today. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a feature whose interview checks just passed, when the engine records `security_gate_1`, then a security-reviewer session starts for that feature's spec commit without any owner action. | FR-1 |
| AC-2 | Given the engine starts with a feature already at `security_gate_1` and no Gate 1 report for its spec commit, then a Gate 1 run starts. With a report for that commit already present, no run starts. | FR-1 |
| AC-3 | Given a Gate 1 session, then its container mounts the worktree read-only, has no network route other than the proxy's model API host, and the session's tools are only `Read`, `Grep`, `Glob`, `Skill` and the gate tools. | FR-2 |
| AC-4 | Given the reviewer writes or changes any file in the worktree by any means, then the engine rejects the session's changes and files a Security item, as for the analyst (AC-9 of F-007). | FR-2 |
| AC-5 | Given the reviewer submits a finding with an unknown criterion id, an unknown severity, or text over its cap, or a report missing a checklist answer, then the tool refuses it with the reason and nothing is written. | FR-5 |
| AC-6 | Given a valid report with no findings, then the agent report and the rendered Gate 1 report are committed on the feature branch after the secrets scan, and `engine.status` shows `readiness_gate`. | FR-6, FR-7, FR-12 |
| AC-7 | Given a valid report with a finding resolved by a new requirement, then the feature does not reach `readiness_gate` until the spec has an Approved SR citing that finding and passes the interview checks. | FR-8, FR-9 |
| AC-8 | Given a finding that needs the owner's choice, then one Security item is filed in the decision inbox with the reviewer's options and recommendation, and the feature is `blocked`. | FR-8 |
| AC-9 | Given the engine stops during a Gate 1 run, when it starts again, then the run resumes or restarts from its last commit, as analyst runs do. | FR-10 |
| AC-10 | Given the master's `models.yaml` or `limits.yaml` has no `security-reviewer` entry, then no Gate 1 session starts and the transcript and engine log say why. | FR-11 |
| AC-11 | Given F-002 in the end-to-end trial project, parked at `security_gate_1`, when the engine runs with this feature, then F-002 gets a Gate 1 report and moves on as AC-6 to AC-8 say. | FR-1 to FR-9 |

## 5. Constraints
- TypeScript in `engine/`, reusing F-007's session, container, proxy,
  worktree, commit, secrets-scan and transcript code. No new library is
  expected; any that turns out to be needed gets the S4.1 review first.
- The same platforms and real-Docker test arrangement as F-007.
- The restart-recovery fix is being made in parallel in the engine's run
  code; this feature builds on it once merged.
- Rapid prototype maturity, as the engine is.

## 6. Edge cases
- The spec or transcript contains text telling the reviewer to report no
  findings, or to file items with chosen wording (prompt injection, S6.1).
- The reviewer's finding text contains Markdown or YAML meant to break the
  rendered report or an inbox item's front matter.
- The spec changes on the branch while Gate 1 runs.
- A finding cites an SR that the analyst later removes or downgrades.
- The reviewer finishes without calling the report tool, or calls it twice.
- The project's security additions file is missing, a link, or too large.
- Gate 1 runs on a spec that the engine finds was changed outside the
  engine (transcript chain or branch check fails).

## 7. Dependencies
- F-007 engine (merged), and the restart-recovery fix (in progress).
- `agents/security-reviewer/AGENT.md`, `skills/security-review/SKILL.md`,
  `docs/security-standards.md` at the pinned factory version.
- The decision inbox format (Inbox item v1.1) for Security items.
- The next feature (inbox reading with signed owner actions and the full
  readiness gate) for features blocked on a Security item.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | After findings are resolved, the engine's check (FR-9) is enough; the reviewer does not run a second time on the revised spec. | | Pending |
| A-2 | The reviewer reads the feature's interview transcript, because answers there shape what the spec means. | | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Least privilege (S8): the reviewer has no write, no shell, no commands, no network other than the model API, and a read-only worktree. | Analyst | Draft |
| SR-2 | The spec, transcript and project security additions are untrusted data to the reviewer (S6.1); its instructions say so, and the engine labels them as data. | Analyst | Draft |
| SR-3 | Every engine read of a worktree file for this gate uses the ADR 0015 real-path rule (F-007 SR on `readSpec`). | Analyst | Draft |
| SR-4 | Reviewer text written into the rendered report, an inbox item or the analyst's input is escaped or quoted so it can't change their structure (S1.1, S1.2). Front matter of inbox items is engine-written only. | Analyst | Draft |
| SR-5 | The engine, not the reviewer, decides the stage. A report can't move a feature to `readiness_gate` unless FR-7 or FR-9 holds. | Analyst | Draft |
| SR-6 | The Gate 1 session gets the same caps, container limits and billing check as the analyst (F-007 SR-18), from its own entries. | Analyst | Draft |

## 10. Interface requirements
- OQ-2 may add a new contract, Gate tools v1.0, for the reviewer's report
  tools (Interfaces decision).
- H-0095: `security-reviewer` entries in `engine/config/models.yaml` and
  `engine/config/limits.yaml` (change-controlled; values to be proposed).
- OQ-3 may change how the analyst receives Gate 1 findings (Interview tools
  v1.0 amendment) if findings go back through the interview.
- Agent report v1.2 is used as it stands.

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Open questions for the owner
Asked one at a time. None is assumed.

| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Build Gate 1 on its own first, or all of increment 3 together? | Product | Asked (card, 2026-11-12) |
| OQ-2 | How the reviewer hands in its report: engine tools that validate it (new contract), or by writing `.factory/runs/**/security-reviewer-*.json` as its role policy allows, checked afterwards. | Interfaces | Open |
| OQ-3 | How Gate 1 findings reach the spec with the owner's approval: the analyst puts each new requirement to the owner in the interview, and only choices between options go to the inbox; or every finding goes to the inbox. | Product | Open |
| OQ-4 | Where the reviewer reads the security standards: the engine supplies the pinned factory's `docs/security-standards.md` plus the project's `standards.security` file, read-only at a fixed path. | Architecture | Open |

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-12 | First draft, on the recommended scope of OQ-1 | |
