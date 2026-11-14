# F-016 Security Gate 1

- **Feature:** F-016 The engine acts on the owner's inbox answers and runs the
  readiness gate, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there.
- **Result:** 5 findings: 0 Critical, 0 High, 2 Medium, 3 Low. Nothing
  blocks. Recommendations are proposed as SR-6 to SR-10 in the spec, for the
  owner to approve. OQ-3 is already an open Security decision and is not
  repeated here.

## Scope
F-016 adds no external service and no new library. It uses F-011's GitHub
calls (F-011 SR-1, threat model in `F-011-security-gate1-r2.md`) and adds
what the engine does after an owner action is recorded: Gate 1 item effects,
engine Security item effects, the readiness gate and spec sign-off. The trust
question is therefore mostly inside the factory: can anything other than the
owner's recorded, confirmed action move a feature forward, and does an
answer reach the spec faithfully?

## Findings
| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S2.1, S6.2 | Medium | No | FR-3 has the analyst write the owner's Gate 1 choice into the spec and says the engine checks the row "matches" the recorded choice, without saying what matches. An analyst steered by spec or transcript text (S6.1) could cite the item with a requirement that says something weaker than the chosen option, and the check would pass on the citation alone. | **SR-6:** a choice is resolved only by an Approved section 9 row whose source cites `Gate 1 #<n>; <item id>` and whose text contains the chosen option's label word for word (normalized whitespace); the check names the finding when not. |
| 2 | S2.1, S5.1 | Medium | No | FR-2 runs an effect after the record commit. If the effect fails halfway (GitHub error, engine stop), the stage may be set without the matching record or the reverse, and nothing says which wins. | **SR-7:** the stage change and the `effect_done` entry are written in one commit on the feature's chain, after the inbox record; an effect that fails leaves the stage unchanged and is retried at the next poll; after 3 failed tries a Notice is filed and the feature stays where it is. |
| 3 | S6.1, S6.2 | Low | No | The "resume" effect (FR-6) restarts an analyst or reviewer that broke its rules. If the cause was injected text in the spec or transcript, the same text is there after the restart, so the owner's Approve could start a loop of violations and items. | **SR-8:** a resume restart counts against the feature's existing run caps (F-007 `MAX_RESUMES`, F-008 SR-11); once a cap is reached, option A files a Notice saying so and restarts nothing. |
| 4 | S8.5, S8.2 | Low | No | The project's factory token needs a new permission, Issues read and write, for F-011. Section 5 mentions it but not its scope or reason as S8.5 asks. | **SR-9:** the factory token's added permission is Issues read and write on the config repo only, for filing and reading inbox items (F-011 SR-1); managed code repos get no Issues permission in this increment. The engine checks it at start and reports a missing permission instead of filing. |
| 5 | S7.1, S3.2 | Low | No | FR-5 records an accepted risk only in the feature's Gate 1 state on `factory/state`. Gate 2 and the validation judge read the spec, so an accepted risk is invisible to them and to a developer. | **SR-10:** the analyst also records each accepted risk in section 9 with status `Accepted risk`, citing `Gate 1 #<n>; <item id>`; the readiness gate fails if a recorded accepted risk has no such row. |

## Checklist answers
- **Touches input, auth, secrets, sensitive data, dependencies, external
  systems?** Input: owner comments and reactions (through F-011's reader),
  reviewer text and owner notes passed to agents (SR-2). Auth: every effect
  depends on F-011 SR-2 and SR-3 (SR-1, SR-3). No secrets handled beyond the
  existing token. No new dependency. External: GitHub only, as F-011 SR-1.
- **Permissions:** Issues read/write on the config repo for the factory
  token (finding 4, SR-9). No new agent tool. OQ-1 (b) or (c) would add an
  orchestrator session, read-only, under a role policy (H-0184).
- **New library or component?** No.
- **Reads or acts on anything external?** Reads issue comments and
  reactions; acts by commenting, labelling and closing issues in the
  owner's private config repo, all granted by F-011 SR-1 and ADR 0022.
  Threat model: F-011's applies; F-016 adds no service.
- **Requirement for each?** SR-1 to SR-5 plus SR-6 to SR-10 below.
- **Abuse cases:** another account reacts (F-011 SR-2); a stale action
  after the spec moved (SR-3, FR-9); reviewer or owner text with
  instructions reaching an agent (SR-2); an analyst recording a weaker
  requirement than the owner chose (finding 1); a restart loop (finding 3);
  half-applied effects (finding 2). All are in section 6 or covered by SRs.
- **Owner decisions:** OQ-3 (owner keys through the inbox) is Security and
  open; approval of SR-6 to SR-10.

## Permissions the feature adds
- Factory token: Issues read and write, config repo only (SR-9).

## Not applicable
- S4: no new external component.
- S9.7 new threat model: no new external service; F-011's covers GitHub.
