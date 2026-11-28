# 0037. A separate CI token lands the CI jobs the owner approves

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** owner
- **Decision item:** F-026 decision cards, 2026-11-28 (OQ-1 01:01Z, OQ-2 01:02Z, OQ-3 01:03Z, OQ-4 01:09Z), spec v2 sign-off with the SR-5 risk accepted (01:12Z)

## Problem

Tests that only CI can run (F-015 FR-29) need CI jobs, but no part of the
factory can add one. Agents may not write `.github/**` (F-015 SR-3), and the
owner token has no Workflows permission (F-015 SR-2), so GitHub refuses any
push that touches a workflow file. Mesbot F-005 needs six CI jobs.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A: a second fine-grained token per GitHub owner, Contents, Pull requests and Workflows write, read by one engine module for approved CI items | The owner token keeps GitHub's own refusal of workflow pushes, which backs SR-3 on every agent build push | One more token per owner to make and renew |
| B: add Workflows write to the owner token | Nothing new to set up | An agent build push that slips a workflow past the end-of-session check would run with the repo's secrets and could fake a required check |
| C: the console pushes with the owner's own Git login and the owner merges | No new token | Uses the owner's broad login; the owner merges every change by hand |

Until Beta (ADR 0026, accepted risk 1) code an agent runs can read any
credential in the owner's store, so A's gain over B is against engine
mistakes now and against agents again from Beta.

## Implications

- Security: the CI token can push a workflow to any branch of a project
  repo, and such a workflow runs at once with every secret not behind a
  protected environment. Accepted by the owner until Beta (F-026 SR-5),
  with these limits: the token expires within 30 days and the engine files
  a renewal item 7 days ahead; it has no Administration permission, so it
  can't change branch protection or rulesets; onboarding advises keeping CI
  secrets in an environment with a required reviewer.
- Maintenance: workflow files come only from engine templates (OQ-2 A);
  their pins, tool versions, flagged commands and risk text sit in
  `engine/src/ci/catalog.json`, which is change-controlled. The factory's
  own CI renders every template and runs actionlint and zizmor on it.
- Required checks stay the owner's step in GitHub's settings (OQ-3 A); only
  the test engineer may ask for a CI job (OQ-4).

## Decision

Option A. The engine files each CI job request as a Hygiene item holding
the rendered files. On approval, `engine/src/ci/push.ts`, the only module
that reads `ci-token/<project>/<owner>`, pushes exactly the approved files
on `hygiene/<item>`, opens the pull request and merges it through the
hygiene auto-merge once its files hash to the approved diff and its
required checks pass.

## Consequences

- The owner makes and renews one CI token per GitHub owner of a project.
- A CI job the templates can't express needs a catalog change, never
  hand-written YAML.
- From Beta, when agents no longer run with the owner's credential store,
  the CI token is out of agents' reach and this split pays off fully.
