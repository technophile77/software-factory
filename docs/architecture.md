# Architecture

**Status:** core architecture decided 2026-11-08 (ADRs 0001 to 0007).
Interface details are still to be decided; see `open-decisions.md`.

## Fixed by the spec

These are requirements, not choices:

- The owner's control surface is **VS Code**, with three inboxes: Decisions,
  Testing, and Configuration hygiene.
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
 Owner ── VS Code ── Inboxes (Decision, Testing, Config hygiene)
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
| Inbox store | ADR 0002: one file per item under `.factory/inbox/`, in Git |
| VS Code extension | ADR 0003: engine is a separate local process; extension is the UI (tree views + detail webview) |
| Agent isolation and permissions | ADR 0004: Git worktree per agent; per-role write/command/network policy. ADR 0015: container per agent session, one path-matching rule, SSH-signed owner actions |
| Branching | ADR 0005: `feature/F-nnn-name` + `feature/F-nnn/<agent>`, squash merge |
| PR integration | ADR 0017: owner's own fine-grained token; inbox click merges; `main` requires PR and CI, no review, no bypass (ADR 0006 machine account optional) |
| Concurrency | ADR 0007: unlimited, with rebase-and-retest after each merge |
| CI | ADR 0008: GitHub Actions, required merge gate, jobs scaled by maturity |
| Factory state | ADR 0009: `factory/state` branch, checked out at `.factory/` |
