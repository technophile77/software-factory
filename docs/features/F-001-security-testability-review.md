# F-001 Security and Testability Review (requirements review)

- **Feature:** F-001 Decision inbox in VS Code, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-08
- **Result:** 3 missing requirements found and added to the spec (SR-3 to SR-5). No owner decision needed.

| # | Criterion | Severity if missed | Finding | Resolution |
|---|---|---|---|---|
| 1 | S1.2, S6.1 | High | Item bodies are written by agents that read untrusted content, so a body could carry script. SR-1 needed a concrete CSP rule. | SR-1 tightened; AC-12 added |
| 2 | S1.4 | High | Item `links` are free text; a link like `../../.ssh/id_rsa` would open a file outside the repo. | SR-3 added; AC-11 added |
| 3 | S1.3 | Medium | Item ids flow into file paths and commit messages; shell invocation of git would allow injection. | SR-4 added |
| 4 | S5.1 | Low | A crash mid-write could corrupt an item; unknown fields could be dropped. | SR-5 added |

**Abuse cases now covered in edge cases:** malicious body markup, path-escaping links, crafted ids.

**Not applicable:** S2 (no auth; local single user), S3 (no secrets handled), S4 (dependencies reviewed at Code Review).
