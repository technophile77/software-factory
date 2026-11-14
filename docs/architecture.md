# Architecture

**Status:** core architecture decided 2026-11-08 (ADRs 0001 to 0007).
Interface details are still to be decided; see `open-decisions.md`.

## Fixed by the spec

These are requirements, not choices:

- The owner's control surface is **VS Code**, with one inbox (F-011): GitHub
  issues shown by Microsoft's GitHub Pull Requests extension, and GitHub
  Mobile on the phone (ADR 0022). Each item is labeled by its kind: Decision
  (with its category), Hygiene, Testing, Spec sign-off, Maturity, or Notice.
- Code is written through **Claude Code**.
- There are **six primary agent roles**, three advisory support roles
  (project evaluator, context hygiene, advisor) and a web reader that fetches pages
  for the analyst (F-005), with separate responsibilities
  (`agent-responsibilities.md`). The developer, test engineer, security
  reviewer, and validation judge must work independently of each other.
- All factory configuration lives in **Git**, and every change to it is
  approved, committed, traceable, and reversible.
- The lifecycle has **nine stages** with hard gates
  (`development-workflow.md`).

## Components (logical, not yet technical)

```
 Owner ── VS Code / phone ── Inbox (GitHub issues, labeled by kind)
                         ▲            │ approve / reject / defer ...
                         │            ▼
                  Inbox store  ◄──  Orchestration  ──►  Agents (6 roles)
                                       │                   │
                                       └──── Git repo ◄────┘
```

How each box is built is decided in ADRs:

| Component | Decision |
|---|---|
| Orchestration | ADR 0001: TypeScript workflow engine; one Claude Agent SDK session per agent; gates enforced in code |
| Inbox store | ADR 0022: one GitHub issue per item in the private config repo; records on `factory/state` (supersedes ADR 0002) |
| VS Code UI | ADR 0003, amended by 0022: engine is a separate local process; the inbox UI is Microsoft's GitHub Pull Requests extension |
| Agent isolation and permissions | ADR 0004: Git worktree per agent; per-role write/command/network policy. ADR 0015: container per agent session, one path-matching rule, SSH-signed owner actions. ADR 0026: until Beta, agents run on the owner's PC without containers |
| Branching | ADR 0005: `feature/F-nnn-name` + `feature/F-nnn/<agent>`, squash merge |
| PR integration | ADR 0017: owner's own fine-grained token; owner merges in GitHub's PR view (ADR 0022); `main` requires PR and CI, no review, no bypass (ADR 0006 machine account optional); at Rapid prototype CI is advisory and Claude merges PRs whose content the owner approved (ADR 0030) |
| Concurrency | ADR 0007: unlimited, with rebase-and-retest after each merge |
| CI | ADR 0008: GitHub Actions, required merge gate, jobs scaled by maturity |
| Factory state | ADR 0009: `factory/state` branch, checked out at `.factory/` |

## Data formats

Owner's rule, 2026-11-14 (H-0240, proposal 0034): data an agent reads or
writes is JSON unless a reason below applies. Each JSON format names itself
and its version in a `schema` field, has a JSON Schema that code checks on
every read and write, keeps prose inside string fields, and holds facts
only. Code makes policy decisions (what blocks, what is allowed) from the
facts and from one JSON policy table per policy, which every consumer reads
(for example `security-blocking.json`, H-0235).

Reasons for another format, stated wherever the format is defined:

1. **Written for the owner to read:** specs, ADRs, proposals and rendered
   reports are Markdown. Code takes its facts from the JSON the Markdown is
   rendered from, or from a JSON description of its structure
   (`docs/features/feature-template.structure.json`).
2. **Fixed by an outside tool:** `AGENT.md` and `SKILL.md`, GitHub issue and
   PR bodies, JUnit XML, `gitleaks.toml`, `osv-scanner.toml`, GitHub Actions
   workflows, `package.json`.
3. **Edited by hand, with comments:** the configuration files proposal 0034
   lists, pending the owner's choice there.
4. **Append-only streams** use JSON Lines, which counts as JSON.
