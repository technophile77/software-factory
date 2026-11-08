# Architecture

**Status:** not yet designed. Every major choice here belongs to the owner and
is recorded as an ADR first. See `open-decisions.md` for what is pending.

## Fixed by the spec

These are requirements, not choices:

- The owner's control surface is **VS Code**, with three inboxes: Decisions,
  Testing, and Configuration hygiene.
- Code is written through **Claude Code**.
- There are **six agent roles** with separate responsibilities
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

| Component | Decided by |
|---|---|
| Orchestration | Open decision 2 |
| Inbox store | Open decision 3 |
| VS Code extension | Open decision 1 |
| Agent sandboxing and permissions | Open decision 4 |
| Git and PR integration | Open decisions 5 and 9 |
| Concurrency | Open decision 10 |
