# Feature: Run Security Gate 1 on the real engine

- **Id:** F-008
- **Status:** In review
- **Requested by / date:** Alex, 2026-11-12
- **Spec version:** 8

This is part of the engine's increment 3 ("Requirements to ready", F-007
section 13). The owner chose to build Security Gate 1 on its own first
(OQ-1, decision card, 2026-11-12). Reading inbox decisions under signed
owner actions (ADR 0015) and the full readiness gate come in the next
feature.

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
   checks. The reviewer can read the worktree and write only its own report
   file: no shell, no network apart from the model API.
3. The reviewer gets its `AGENT.md`, the shared `security-review` skill and
   the factory's `docs/security-standards.md` from the factory version the
   project pins, plus the project's own security additions file
   (`standards.security` in the manifest), read-only at a fixed path (OQ-4). It follows the
   Gate 1 checklist and writes its report as the agent report file its role
   policy allows (OQ-2).
4. When the session ends, the engine checks what the reviewer wrote. If the
   report is invalid, the reviewer is told why and may correct it. A valid
   report is committed on the feature branch with a rendered
   `docs/features/<feature>-security-gate1.md`, after the secrets scan.
5. If there are no findings, the feature moves to `readiness_gate`.
6. Findings the reviewer resolves with a new or tightened security
   requirement send the feature back to `requirements_interview`. The
   analyst gets the findings as data and puts each requirement to the owner
   as an interview question with the requirement as its suggested answer;
   the owner approves, changes or rejects it in the spec interview as usual
   (OQ-3). Findings that need the owner's choice between options are filed
   as Security items in the decision inbox, and the feature waits
   (`blocked`) until they are decided, which needs the next feature.
7. Once every finding is resolved by an approved requirement in the spec,
   and the spec passes the interview checks again, the engine checks the
   findings are resolved (it does not run the reviewer again) and the
   feature moves to `readiness_gate`. A requirement the owner rejects is
   filed as a Security item asking the owner to accept the risk. The full readiness gate and reading inbox decisions
   come in the next feature (OQ-1).
8. `engine.status` shows the feature's stage throughout, and the transcript
   and engine log say why a gate didn't run or didn't finish.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | When a feature of an enabled, running project enters `security_gate_1` from a passing interview and has no unresolved Gate 1 findings, the engine starts one Gate 1 run on that spec commit; at engine start it starts one for a feature at `security_gate_1` that has no Gate 1 report since it last entered the stage. A feature returning from the findings interview gets the FR-9 check, not a new run (Gate 1 #6). One Gate 1 run per feature at a time. |
| FR-2 | The reviewer runs as an Agent SDK session in its own container under the project's `security-reviewer` role policy and every container rule of Role policy v2.5. Its only write is its report, `.factory/runs/<feature>/security_gate_1/security-reviewer-<n>.json` on the feature branch, which the engine names in its input; the end-of-session write check rejects every other change. |
| FR-3 | The engine gives the reviewer: its `AGENT.md` and the `security-review` skill as the analyst gets its own (F-007), `docs/security-standards.md` from the master clone commit the project's `factory.version` names and the project's `standards.security` file from the config repo's `main` commit, read-only at a fixed path outside the worktree (OQ-4, SR-10), the feature's spec path and version, and the feature's interview transcript as data. |
| FR-4 | The reviewer writes its report as an Agent report v1.2 file with the `security-reviewer` body (OQ-2). The engine fills the envelope fields that agents don't (v1.1). Each finding has criterion id, severity, location, explanation, suggested resolution and whether it needs the owner's choice. The report also answers each Gate 1 checklist question, lists the permissions the feature adds (S8.5), the abuse cases, and what is not applicable with the reason. |
| FR-5 | After the session, the engine validates the report file: valid JSON within a size cap, the right schema, role, feature, stage and commit, known criterion ids from the standards it gave, known severities, every checklist question answered, text within caps. If it is missing or invalid, the engine resumes the same session once with the reasons; if it is still invalid, the run fails and nothing from it is committed. |
| FR-6 | For a valid report, the engine renders `docs/features/<feature>-security-gate1.md` in the layout the factory's existing Gate 1 reports use, then scans and commits the report and the rendering on the feature branch (ADR 0012). |
| FR-7 | A report with no findings moves the feature to `readiness_gate`. |
| FR-8 | Findings handled per OQ-3. A finding with a suggested requirement moves the feature back to `requirements_interview`; the next analyst session gets every such finding, quoted as data, and asks one interview question per finding (Interview tools v1.0 `interview_ask`, the requirement as `suggested`), citing the finding. A finding marked `needs_owner` is filed as a Security item in the decision inbox with the reviewer's options and recommendation, and the feature is `blocked` while any is open. |
| FR-9 | Before moving to `readiness_gate` after findings, the engine checks every finding is resolved: a security requirement in the spec's section 9 that cites the finding, with status Approved and text matching the owner's approved answer in the transcript, or a decided Security item (Gate 1 #7). A finding that isn't resolved keeps the feature at `security_gate_1` and the check's evidence names it. |
| FR-10 | Gate 1 runs are resumable and interruptible as analyst runs are (FR-14 of F-007, with the restart-recovery fix), within `MAX_RESUMES`. A run that fails is recorded in the transcript, the engine log and the agent report, with the reason. |
| FR-11 | The reviewer's model and session limits come from the master's `engine/config/models.yaml` and `engine/config/limits.yaml` at the pinned factory version, through hygiene item H-0095; the engine has no defaults. A project's `limits:` may only lower them. |
| FR-12 | `engine.status` reports the feature's stage at every step; the stage is recorded on the feature's transcript chain as today. |
| FR-13 | A Gate 1 question the owner rejects files a Security item asking the owner to accept the risk or send the feature back, quoting the finding; the feature is `blocked` until it is decided. A deferred one leaves the finding unresolved (Gate 1 #7). |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a feature whose interview checks just passed, when the engine records `security_gate_1`, then a security-reviewer session starts for that feature's spec commit without any owner action. | FR-1 |
| AC-2 | Given the engine starts with a feature already at `security_gate_1` and no Gate 1 report for its spec commit, then a Gate 1 run starts. With a report for that commit already present, no run starts. | FR-1 |
| AC-3 | Given a Gate 1 session, then its container has no network route other than the proxy's model API host, and the session's tools are only `Read`, `Grep`, `Glob`, `Write` and `Skill`. | FR-2 |
| AC-4 | Given the reviewer writes or changes any file other than its named report, by any means, then the engine rejects the session's changes and files a Security item, as for the analyst (AC-9 of F-007). | FR-2 |
| AC-5 | Given the reviewer's report has an unknown criterion id, an unknown severity, text over its cap, a missing checklist answer, wrong envelope values or invalid JSON, or is missing, then the engine resumes the session once with the reasons; given the corrected report is still invalid, then the run fails, nothing is committed, and the transcript and engine log say why. | FR-5 |
| AC-6 | Given a valid report with no findings, then the agent report and the rendered Gate 1 report are committed on the feature branch after the secrets scan, and `engine.status` shows `readiness_gate`. | FR-6, FR-7, FR-12 |
| AC-7 | Given a valid report with a finding resolved by a new requirement, then the feature does not reach `readiness_gate` until the spec has an Approved SR citing that finding and passes the interview checks. | FR-8, FR-9 |
| AC-8 | Given a finding that needs the owner's choice, then one Security item is filed in the decision inbox with the reviewer's options and recommendation, and the feature is `blocked`. | FR-8 |
| AC-9 | Given the engine stops during a Gate 1 run, when it starts again, then the run resumes or restarts from its last commit, as analyst runs do. | FR-10 |
| AC-10 | Given the master's `models.yaml` or `limits.yaml` has no `security-reviewer` entry, then no Gate 1 session starts and the transcript and engine log say why. | FR-11 |
| AC-12 | Given the spec or transcript contains text telling the reviewer to report no findings, and the spec's section 9 has no requirement, when the reviewer files an empty report, then it is refused as invalid. | SR-7 |
| AC-13 | Given the report path is a symbolic link, over 256 KiB, nested deeper than the limit, or any path other than the named one is changed, then nothing is read through the link, the report is invalid or the session's changes are rejected. | SR-8, SR-12 |
| AC-14 | Given finding text with Markdown links, images, HTML or a heading, then the rendered report and inbox item show it as plain text. | SR-4 |
| AC-15 | Given finding text containing a secret the scanner detects, then no report, rendering, inbox item or analyst input carrying it is written or sent, and a Security item with engine text only is filed. | SR-9 |
| AC-16 | Given a project additions file that defines an `S` criterion id, then the gate runs on the factory standards alone and a Security item says why. | SR-10 |
| AC-17 | Given a feature returns to `security_gate_1` from the findings interview, then no new reviewer session starts; and given a feature has had 3 Gate 1 runs, then a fourth doesn't start and a Security item is filed. | FR-1, SR-11 |
| AC-18 | Given the owner rejects a Gate 1 question, then a Security item is filed and the feature is `blocked`; given an SR that cites a finding but whose text differs from the owner's approved answer, then FR-9 fails naming it. | FR-9, FR-13 |
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
- A reviewer that keeps finding new issues each run (SR-11).
- The owner rejects or defers a requirement Gate 1 suggested (FR-13).
- A quoted secret in a finding (SR-9).
- Project additions that try to relax or redefine the factory's rules (SR-10).

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
| A-1 | After findings are resolved, the engine's check (FR-9) is enough; the reviewer does not run a second time on the revised spec. | Owner, decision card, 2026-11-12 | Approved |
| A-2 | The reviewer reads the feature's interview transcript, because answers there shape what the spec means. | Owner, decision card, 2026-11-12 | Approved |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Least privilege (S8): the reviewer writes only its named report file, and has no shell, no commands and no network other than the model API. | Analyst | Draft |
| SR-2 | The spec, transcript and project security additions are untrusted data to the reviewer (S6.1); its instructions say so, and the engine labels them as data. | Analyst | Draft |
| SR-3 | Every engine read of a worktree file for this gate uses the ADR 0015 real-path rule (F-007 SR on `readSpec`). | Analyst | Draft |
| SR-4 | Reviewer text written into the rendered report or an inbox item is plain text: Markdown control characters escaped, no raw HTML, no links or images. In the analyst's input it is JSON strings in a labelled data block. Inbox front matter is engine-written only (S1.1, S1.2). | Analyst; Gate 1 #3 | Draft |
| SR-5 | The engine, not the reviewer, decides the stage. A report can't move a feature to `readiness_gate` unless FR-7 or FR-9 holds. | Analyst | Draft |
| SR-6 | The Gate 1 session gets the same caps, container limits and billing check as the analyst (F-007 SR-18), from its own entries. | Analyst | Draft |
| SR-7 | The reviewer's input puts factory instructions and standards first, then each untrusted text (spec, transcript, project additions) in a labelled data block with its source. A report with no findings must answer every checklist question with reasons citing spec sections and list the permissions the feature adds; an empty report on a spec whose section 9 has no requirement is invalid (S6.1). | Gate 1 #1 | Draft |
| SR-8 | The engine reads the report from the session's commit in git, never through the file system: exactly the named path, mode 100644, at most 256 KiB, parsed with a nesting limit (S1.4). | Gate 1 #2 | Draft |
| SR-9 | The secrets scan covers the report, the rendering, each inbox item before commit, and the analyst's input before a session starts. A hit stops that output and files a Security item with engine text only (S3.1). | Gate 1 #4 | Draft |
| SR-10 | Project additions are data after the factory standards and can only add criteria, with `P`-prefixed ids. An `S` id defined there makes the file invalid and the gate runs on the factory standards alone, with a Security item. Severity definitions and the blocking table come only from the factory standards. The file is a regular file in the config repo, at most 64 KiB (S6.1, S7). | Gate 1 #5 | Draft |
| SR-11 | At most 3 Gate 1 runs per feature, the correction resume included; a fourth needs the owner and files a Security item (S5.1). | Gate 1 #6 | Draft |
| SR-12 | The write check accepts exactly the run's named report path, not every path the role's write glob allows (S8.1). | Gate 1 #8 | Draft |

## 10. Interface requirements
- H-0095 (draft, for owner approval): new entries in the change-controlled
  engine config.

  ```yaml
  # engine/config/models.yaml
  security-reviewer: claude-opus-5-5   # a gate agent: same model as the analyst
  # engine/config/limits.yaml
  security_reviewer:
    turns: 100
    output_tokens: 200000
    dollars: 5 # API key (tokens) mode only
    wall_time_minutes: 60
    cpus: 1
    memory_mib: 1024
    pids: 128
    tmp_mib: 256
  security_gate_1:
    runs_per_feature: 3        # SR-11
    report_kib: 256            # SR-8
    additions_kib: 64          # SR-10
  ```
- Interview tools v1.0 are used as they stand: Gate 1 requirements are
  ordinary questions with a suggested answer (OQ-3).
- Role policy v2.5 is used as it stands (OQ-2).
- H-0096: Agent report v1.3 adds optional `security-reviewer` body fields
  for Gate 1, `checklist` (question, answer), `permissions_added`,
  `abuse_cases` and `not_applicable` (criterion, reason), and a finding's
  `needs_owner` with `options` and `recommendation`. Optional fields only,
  so non-breaking, but an Interfaces change for the owner's approval.

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
| OQ-1 | Build Gate 1 on its own first, or all of increment 3 together? | Product | Decided: Gate 1 first, the rest of increment 3 next (owner, decision card, 2026-11-12) |
| OQ-2 | How the reviewer hands in its report: engine tools that validate it (new contract), or by writing `.factory/runs/**/security-reviewer-*.json` as its role policy allows, checked afterwards. | Interfaces | Decided: the reviewer writes the report file its role policy allows; the engine checks it after the session (owner, decision card, 2026-11-12) |
| OQ-3 | How Gate 1 findings reach the spec with the owner's approval: the analyst puts each new requirement to the owner in the interview, and only choices between options go to the inbox; or every finding goes to the inbox. | Product | Decided: new requirements through the interview, choices between options to the inbox (owner, decision card, 2026-11-12) |
| OQ-4 | Where the reviewer reads the security standards: the engine supplies the pinned factory's `docs/security-standards.md` plus the project's `standards.security` file, read-only at a fixed path. | Architecture | Decided: the pinned factory's `docs/security-standards.md` plus the project's `standards.security` file, read-only at a fixed path (owner, decision card, 2026-11-12) |

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-12 | First draft, on the recommended scope of OQ-1 | |
| 2 | 2026-11-12 | OQ-1: Gate 1 on its own first; inbox reading with signed actions and the full readiness gate next | Owner, 2026-11-12 (decision card) |
| 3 | 2026-11-12 | OQ-2: the reviewer writes its own report file; the engine validates it after the session, with one correction turn | Owner, 2026-11-12 (decision card) |
| 4 | 2026-11-12 | OQ-3: Gate 1 requirements go to the owner as interview questions; choices between options go to the inbox | Owner, 2026-11-12 (decision card) |
| 5 | 2026-11-12 | OQ-4: pinned factory standards plus the project's additions | Owner, 2026-11-12 (decision card) |
| 6 | 2026-11-12 | Security Gate 1 (`F-008-security-gate1.md`): SR-4 tightened, SR-7 to SR-12, FR-13 added, FR-1 and FR-9 tightened, AC-12 to AC-18 | Pending owner approval with the spec |
| 7 | 2026-11-12 | A-1 approved: no second reviewer run after findings are resolved | Owner, 2026-11-12 (decision card) |
| 8 | 2026-11-12 | A-2 approved: the reviewer reads the interview transcript as labelled data | Owner, 2026-11-12 (decision card) |
