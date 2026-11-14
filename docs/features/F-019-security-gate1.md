# F-019 Security Gate 1 (requirements review)

- **Feature:** F-019 Stateful parts of the engine can't reach a dead end, spec v4
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-14
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there.
- **Result:** 5 findings: 0 Critical, 0 High, 1 Medium, 4 Low. Nothing
  blocks. The owner's decisions (A-1, A-2, OQ-1, ADR 0031) are not
  re-opened. Recommendations are proposed as SR-2 to SR-6 in the spec, for
  the owner to approve.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S2.1, S2.3 | Medium | No | OQ-1 makes a second hand-close of an unanswered inbox issue withdraw the item, and whatever waited on it fails. Anyone with write access to the config repo, or a workflow with `issues: write`, can close an issue. A close by someone other than the owner could then cancel an owner question, such as a Security item, without the owner seeing it. | SR-2: only a close by the owner's GitHub account (the same actor id check F-011 uses for actions) counts toward OQ-1. Any other close is reopened with a note every time, and never withdraws the item. A test closes an item as a different actor twice and checks that it stays open. |
| 2 | S4.1, S4.3, S4.4 | Low | No | jssm and both of its runtime dependencies are published by one npm account (ADR 0031 review). A compromised account could ship a malicious patch release. | SR-3: jssm and its dependencies are pinned exactly in `package.json` and installed with `npm ci` from the lockfile with integrity hashes. Any version change is a new S4.1 review. The CI osv-scanner and `npm audit` jobs cover all three, including the optional visualiser packages. |
| 3 | S1.1 | Low | No | jssm builds a machine by parsing its text definition at run time. If any part of that text came from the event log or a config file, crafted text could add states or transitions. | SR-4: machine definitions are string constants in engine source, with no interpolation. A test checks that each definition module's `sm` call has no template substitutions. |
| 4 | S5.1 | Low | No | jssm throws on an unknown state and returns false on an illegal move. If a throw during replay goes uncaught, it could stop the engine for every feature, not just the bad one. | SR-5: replay catches jssm errors per feature and handles them the same way as FR-6's refused event: that feature pauses with an owner item, and the other features carry on. A test replays a log with an unknown state name. |
| 5 | S5.1, S6 | Low | No | Under A-1, a forbidden move in the log pauses the feature. Anything that can write to `factory/state` could therefore pause features. That write access is already the forged-record risk the owner accepted until Beta (F-017). | SR-6: the pause item names the event's commit, so the owner can see where it came from. No other control until Beta. |

**Already covered by the spec or decisions:** event and state names are
checked against the typed unions before they reach jssm (SR-1). The engine
imports only `jssm`, never `jssm/viz`, so the visualiser is not in the
runtime bundle (ADR 0031).

**Not applicable:** no new external service or permission. The inbox calls
(close and reopen an issue) are already granted by F-011 SR-1, so there is
no new S9.7 threat model.
