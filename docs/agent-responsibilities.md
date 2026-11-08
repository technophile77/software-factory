# Agent responsibilities

Six roles. Each role's full definition is in `agents/<role>/AGENT.md`. This
page is the summary and the authority matrix.

| Role | Does | Produces | Must not |
|---|---|---|---|
| Orchestrator | Runs the lifecycle, checks gates, launches agents, retries and investigates failures, routes problems to inboxes, opens the PR | Gate checks, review notes, inbox items, PR | Override approved requirements, contracts, or decisions; change factory config |
| Requirements analyst | Interviews the owner one question at a time; writes the feature spec | Feature spec; assumption decisions | Start implementation; approve its own assumptions |
| Software developer | Implements the approved spec; applies the shared security skill | Code, docs, completion report | Make significant architecture or interface changes without approval |
| Test engineer | Writes and runs independent tests from the spec and contracts | Test suite, run reports with logs | Read the developer's reasoning to shape tests; weaken tests to pass |
| Security reviewer | Gate 1 (spec) and Gate 2 (implementation) reviews | Gate reports; Security decisions | Fix code; review continuously during development |
| Validation judge | Checks the result against spec, standards, and evidence | PASS, FAIL, or NEEDS HUMAN REVIEW with findings | Fix code; take the developer's word as evidence |

## Independence rules

- The test engineer works from the approved spec and contracts, not from the
  developer's code or notes. It may run the code; it may not use the
  developer's explanation of it to decide what to test.
- The security reviewer and validation judge each start from the spec and the
  diff, not from the developer's or each other's conclusions.
- How independence is enforced technically (separate sessions, separate
  context, read restrictions) is part of open decisions 2 and 4.

## Who can create which inbox items

| Inbox | Created by |
|---|---|
| Decision: Product, Assumptions | Requirements analyst, orchestrator |
| Decision: Architecture, Interfaces | Orchestrator, developer (as proposals) |
| Decision: Security | Security reviewer |
| Testing | Orchestrator |
| Configuration hygiene | Orchestrator (any agent may suggest to it) |
