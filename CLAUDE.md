# Software Factory — instructions for Claude

This repository is an agent-driven software factory. It also builds itself, so
everything here follows the same rules the factory enforces on other projects.

The baseline specification is `docs/spec/software-factory-spec-v0.1.md`. When
anything in this file or in `docs/` conflicts with it, the spec wins until the
owner approves a change.

## Non-negotiable rules

1. **Requirements before implementation.** No code is written for a feature
   until its spec in `docs/features/` has passed the readiness gate
   (`docs/development-workflow.md`, stage 4).
2. **The owner decides.** Requirements, architecture, interface contracts,
   assumptions, security policy, and factory configuration never change
   silently. Prepare the options and a recommendation, then ask.
3. **Change-controlled files need explicit approval for every edit**, including
   typo fixes. See `docs/decision-management.md` § Configuration hygiene.
   Change-controlled files are: this file, everything under `agents/`,
   `skills/`, `workflows/`, `docs/` (except files under `docs/features/` that
   an in-progress feature owns), and any factory configuration.
4. **Do not assume open design items.** `docs/open-decisions.md` lists what is
   still undecided. If work depends on one, raise it; do not pick an answer.
5. **Only five decision categories exist:** Product, Architecture, Interfaces,
   Assumptions, Security. Do not invent others.
6. **Agents do the work.** Do not hand the owner instructions for things an
   agent can do itself. Keep working on unblocked tasks while a decision is
   pending.

## Where things are

| Path | What it holds |
|---|---|
| `docs/spec/` | The owner's original specification (baseline) |
| `docs/open-decisions.md` | Design items not yet decided, with status |
| `docs/maturity-levels.md` | Promotion criteria and per-level gate bar (spec section 16) |
| `docs/adr/` | Approved architecture decisions |
| `docs/features/` | One spec per feature, from `feature-template.md` |
| `docs/interface-contracts.md` | Approved interfaces; changes need approval |
| `docs/security-standards.md` | Single source of security criteria |
| `agents/<role>/AGENT.md` | Each agent's role, authority, inputs, outputs |
| `skills/security-review/` | Shared security skill (reads the standards doc) |
| `workflows/feature-development/` | The nine-stage lifecycle and its gates |

## Code comments

Explain why, not what. No comments that restate code, pad volume, or prop up
code that should be simpler. Keep comments true when code changes.
