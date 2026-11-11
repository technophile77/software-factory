# Proposal: project boundaries and the project manifest (new item 13)

- **Raised:** 2026-11-09, by the owner
- **Category:** Architecture (where projects live) + Interfaces (manifest format)
- **Status:** Decided (ADR 0010; protected defaults decided 2026-11-09). The
  format is added to `interface-contracts.md` as Project manifest v1.0.

## Owner's requirements
A per-project YAML file, editable by the owner, listing:
1. Every repository in the project.
2. Custom skills made available to the project's agents.
3. Default skills the project overrides.
4. Default skills excluded from the project's agents.
5. Anything else project-specific.

## Layers
1. **Master factory** (`software-factory`): default agents, skills,
   standards, workflow, engine. Knows nothing about specific projects.
2. **Project**: `factory-project.yaml` plus any custom skill and agent files
   it points to. Location depends on the open decision (recommended: one
   small config repo per project).
3. **Member repos**: code, plus their own `factory/state` branch (ADR 0009).

Effective configuration = master defaults, then the project manifest applied
on top. The engine computes it at the start of every agent run and records
the resolved list in the agent report, so it's always clear which skills an
agent actually had.

## Manifest format — Project manifest v1.0 (proposed)

```yaml
schema: factory-project/1.0
name: acme-shop
description: Online shop and its admin tools.

factory:
  version: v0.3.0            # master factory tag this project uses
                             # upgrading = a config hygiene item with a diff

repos:
  - name: shop-web
    url: https://github.com/acme/shop-web
    maturity: beta
  - name: shop-api
    url: https://github.com/acme/shop-api
    maturity: alpha
maturity: alpha              # project level; may not exceed the lowest repo (spec §16)

skills:
  custom:                    # added for this project only
    - name: payments-pci
      path: skills/payments-pci/SKILL.md
      agents: [software-developer, security-reviewer]   # omit = all agents
  override:                  # replace a default skill's content for this project
    - name: some-default-skill
      path: skills/overrides/some-default-skill/SKILL.md
      reason: Why the default does not fit this project.
  exclude:                   # default skills removed for this project
    - name: some-default-skill
      reason: Why this project doesn't need it.

agents:
  custom: []                 # extra agent roles, same format as skills.custom
  override: []               # replace a default agent's instructions

standards:                   # project additions; can only tighten master rules
  security: standards/security-extra.md
  coding: standards/coding.md

complexity: moderate         # preset for initial calibration only (F-002)

settings:                    # overrides of master defaults, within allowed limits
  concurrency: unlimited
  agents:                    # approved rung per role (F-002); omit = master default
    software-developer: { rung: 3 }
    security-reviewer: { rung: 4 }
  retries:
    environment_reruns: 2
    fix_cycles: 3
  ci:
    extra_required_jobs: [e2e]

notes: |
  Free-form, project-specific context every agent reads.
```

## Validation rules (the engine refuses an invalid manifest)
- Every name in `override` and `exclude` must exist in the master version
  pinned by `factory.version`.
- A skill can't be both overridden and excluded.
- `reason` is required for every override and exclusion.
- `maturity` may not exceed the lowest repo's maturity.
- Paths must stay inside the project's config location.
- `settings.agents.<role>.rung` must exist in the pinned factory's ladder and
  may not be below the role's floor (security reviewer and validation judge:
  Sonnet/medium, F-002 A-3).
- **Protected items:** `security-review` and the six core agents
  (orchestrator, requirements-analyst, software-developer, test-engineer,
  security-reviewer, validation-judge) may not appear in `exclude`. An
  `override` of one must link an approved Security decision
  (`decision: D-nnnn`) and may only add rules.

## Change control
The manifest and every file it points to are change-controlled. The owner
edits them directly; an agent proposes edits only through the Configuration
hygiene inbox. Every change is a commit.

## Open questions for the owner
1. Where the manifest lives: decided 2026-11-09, a config repo per project (ADR 0010).
2. Protected defaults: decided 2026-11-09. The `security-review` skill and the six core agents can never be excluded. They may be overridden only to add rules, never remove them, and each such override needs an approved Security decision. All other defaults may be overridden or excluded with a reason.
