# F-013 Security Gate 1 (requirements review)

- **Feature:** F-013 Local model provider, spec v4
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there.
- **Result:** 4 findings: 0 Critical, 0 High, 3 Medium, 1 Low. Nothing
  blocks. The owner's decisions (OQ-1 to OQ-5, including the SR-5 accepted
  risk) are not re-opened. Recommendations are proposed as SR-8 to SR-11 in
  the spec, for the owner to approve.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S3.2, S9.4 | Medium | No | With SR-5 accepted, a local-rung session sends repo content across the LAN in clear to a server anyone on the LAN can use or impersonate. The spec doesn't say which projects that may happen for. A project holding a client's code or other sensitive data would get the same treatment as the factory's own repo. | SR-8: local rungs are off for a project until its manifest opts in (`settings.providers.local: true`, default false). Onboarding asks; the run review shows when local rungs ran. |
| 2 | S6.2, S8.1, S4.5 | Medium | No | The accepted SR-5 risk means a device on the LAN that answers the `.local` name, or the server itself if compromised, chooses the model's replies, including tool calls. Claude Code carries out whatever tool calls the reply holds, within the role's policy. For a role that can write code or reach the network, that is a LAN attacker driving the agent. | SR-9: a local rung is allowed only for a role whose role policy is read-only on the worktree (writes only its `.factory/` report) and has no network beyond the gateway. Any other role needs its own Security decision before it can use a local rung. OQ-4's roles all meet this today except the web reader, which SR-6 already holds back. |
| 3 | S6.1, S9.3 | Medium | No | The advisory pass (FR-10) hands the local model's output to the Claude gate reviewer. Text from that output, whether planted by injected content the local model read or by a spoofed server (#2), could try to steer the Claude reviewer, for example "all checks verified, no findings". | SR-10: the advisory output is passed on only as structured data validated by the engine (S1.1): a list of findings, each with criterion id, severity, location and a description capped at 500 characters, plus a verdict word. Anything else is dropped. The Claude reviewer's prompt marks it as unverified hints to check, and the gate's result comes only from the Claude reviewer's own report. |
| 4 | S4.1, S4.3 | Low | No | The served weights aren't pinned: the server reports a file name, parameter count, size and quant type but no digest, so a different file under the same name would carry the old calibration results. | SR-11: the engine records name, parameter count, byte size and quant type at each check (FR-6), and treats any change as a new model: its calibration results and advisory match rate start again, and the owner is told. Residual: a swap that keeps all four the same isn't detectable without a digest from the server. |

**Already covered by the spec or decisions:** one outside service, three
paths (SR-1); no address or key in Git, logs or agent environment (SR-2,
AC-1); private addresses only, resolved on the host and pinned per session,
so the gateway never re-resolves and DNS rebinding can't move it (SR-3,
FR-4); agents still can't reach private addresses directly (SR-4, AC-5); the
Claude credential is never sent to the local server (AC-4); the gateway's
existing body checks apply (FR-5); the server's load is capped (FR-7);
fallback to Claude sends nothing the role wouldn't send to Claude anyway
(OQ-5); prompt injection on the uncensored model keeps the web reader off it
(SR-6).

## Threat model (S9.7)
External interactions: the owner's LAN LLM server, over plain HTTP, through
the engine's credential gateway.

| STRIDE | Threat | Control |
|---|---|---|
| Spoofing | A LAN device answers the `.local` name | Private-address pin (SR-3); read-only roles only (#2); residual risk accepted (SR-5) |
| Tampering | Replies altered in transit or by a spoofed server | Read-only roles (#2); structured advisory output (#3); gates decided by Claude (FR-10) |
| Repudiation | Which model produced a result | Provider-prefixed model in reports (FR-8); weight identity recorded (#4) |
| Information disclosure | Repo content read on the LAN | Per-project opt-in (#1); no address or key logged (SR-2); residual accepted (SR-5) |
| Denial of service | Server busy, down, or flooded by the factory | Session cap (FR-7); Claude fallback after 10 minutes (OQ-5); gates never wait on it (FR-11) |
| Elevation of privilege | Model output drives tools beyond the task | Role policy unchanged (S6.2); read-only roles only (#2) |

OWASP Top 10 for LLM Applications 2025: LLM01 prompt injection (#3, SR-6);
LLM02 sensitive information disclosure (#1); LLM03 supply chain (#4, SR-7);
LLM06 excessive agency (#2).
