# F-021 Security Gate 1 (requirements review)

- **Feature:** F-021 Answer factory decisions in the console, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-14
- **Maturity level:** Rapid prototype (the engine repo's level). Only
  Critical findings block there (`security-blocking.json`).
- **Result:** 5 findings: 0 Critical, 0 High, 3 Medium, 2 Low. Nothing
  blocks. All five are covered by SR-1, SR-2 and SR-4 to SR-6 in spec v2,
  which need the owner's approval with the rest of section 9; SR-4 also
  needs OQ-2 decided.
- **Not re-opened (owner decisions):** agents on the owner's PC until Beta
  (ADR 0026); no interview sign-in at Rapid prototype and the per-project
  sign-in setting (F-018 FR-13, FR-15, SR-8); the inbox on GitHub issues in
  a private config repo (ADR 0022).

## Gate 1 checklist

| Question | Answer |
|---|---|
| Touches input, auth, secrets, sensitive data, dependencies, external systems? | Input: the owner's keystrokes, item text printed to a terminal (engine text and outside text such as reviewer quotes and log lines). Auth: a second way to give the owner's answer, so far proven only by the owner's GitHub account (ADR 0022). Sensitive data: new private detail kept on the PC. Dependencies: none new. External systems: GitHub, as today (one more fixed comment per console answer). |
| Permissions needed; each the minimum (S8)? | No new token scope: the engine already comments on and closes inbox issues. The widening is of who can answer: any process that reaches the owner-only channel (S8.5), stated in SR-4 and put to the owner as OQ-2. |
| New or upgraded external component; S4.1 review and CVE check? | None. |
| Reads from or acts on anything external; scope, irreversible actions, threat model (S9)? | The engine posts a fixed comment on the owner's own private issue and closes it, as it does after a GitHub answer: the owner's own action, not an S9.2 action. No new S9.7 threat model; the abuse cases in section 6 cover the console. |
| A requirement for each? | Yes after v2: SR-1 to SR-7. |
| Abuse cases in the edge cases? | Added to section 6: menu and code imitation, terminal escapes, answers by a local program, forged console answers on `factory/state`, private detail leaking. |
| Needs the owner's decision (Security)? | OQ-2 (sign-in for console answers) with SR-4's risk; approval of SR-1 to SR-7. |

## Findings

| # | Severity | Criterion | Finding | Requirement |
|---|---|---|---|---|
| 1 | Medium | S1.2, S6.1 | Item bodies hold outside text (reviewer quotes, log lines, option labels from a reviewer). In a terminal it could carry escapes or lines that imitate the command's menu or confirm line, so the owner picks or confirms something other than what he read. On GitHub the fence handles this (F-011 SR-10); the terminal needs F-018's cleaning and margin marker for every line, private detail included. | SR-1 |
| 2 | Low | S2.1, S5.1 | If the confirm code or words could come from item text, or a code could be retried, the second step would prove nothing. The code must come from the engine's answer, bind one action, item, revision and 15 minutes, and a wrong code must end the attempt. | SR-2 |
| 3 | Medium | S2.1, S6.2, S8.5 | Today a Security decision or a spec sign-off is recorded only from the pinned owner's GitHub account. Answering through the local channel with no sign-in lets any program running as the owner do it, including agents with a shell (ADR 0026). This widens who can approve, so it is a Security decision for the owner (S8.5), with the risk stated. | SR-4, OQ-2 |
| 4 | Medium | S3.1, S3.2, S9.4 | Private detail (log lines, a Security item's subject, a secret's location) is the reason the feature exists, so its leak paths must be closed by requirement: `factory/state` commits, issue bodies and comments on any revision, workflow dispatch, model prompts. Log lines can hold secrets, so they need the scan before they are stored or shown. | SR-5 |
| 5 | Low | S1.1, S8.4 | The new local files (private detail, console answer proofs) are read back by the engine; a planted or damaged file must not be trusted, and the files must be owner-only. A forged console answer on `factory/state` must not run an effect, which the local answer file (FR-10) prevents, because it isn't in any repo. | SR-6, FR-10 |

## Notes for Gate 2

- Check that no request to GitHub, no `factory/state` commit and no model
  prompt contains private detail text (AC-6's test, over every revision).
- Check that the lock covers both the poll's `read1` and the console
  answer, with the 100-run race test of AC-4.
- Check the confirm path: wrong code, expired code, revision changed, item
  answered on GitHub in between.
- Check `clean()` runs on private detail and labels before the margin
  marker is added.
