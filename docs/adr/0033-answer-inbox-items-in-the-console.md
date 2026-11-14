# 0033. Inbox items can be answered in the console too

- **Status:** Accepted
- **Date:** 2026-11-14
- **Decided by:** owner
- **Decision item:** decision cards in the thread "Answer factory decisions in the console": OQ-1 both places (10:27Z), OQ-2 follow the sign-in setting (10:28Z), this ADR approved as written with H-0245 to H-0248 (10:30Z); [F-021](../features/F-021-console-decisions.md)

## Problem
Decisions were posed only as GitHub issues. The owner, often just out of an
interview in the terminal, had to switch to GitHub, and an issue can't carry
private detail.

## Decision
Every inbox item stays a GitHub issue and can also be answered in the
console (`factory-engine inbox`, and inside `factory-engine interview`).
The first answer, from either path, is recorded. Private detail stays in the
engine folder on the PC and is shown only in the console. Console answers
follow the project's sign-in setting; they are proven by a local answer
file, not by GitHub.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Both paths, first answer wins (chosen) | Owner answers where his attention is; phone still works; private detail possible | Two paths to keep in step; local answers aren't proven by GitHub |
| Console only | One path | No phone; loses the issue record |
| GitHub only (ADR 0022 as it was) | One proof (GitHub) | Owner leaves the terminal; no private detail |

## Implications
ADR 0022 gains a note: owner answers can also come from the console (F-021).
At Rapid prototype console answers need no sign-in (F-021 SR-4, accepted risk).
