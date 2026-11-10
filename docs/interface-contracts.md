# Interface contracts

Approved interfaces between the factory's components, and between agents.
Nothing here changes without an approved decision in the **Interfaces**
category. Each change updates this file, the implementation, the tests, and
every dependent component together.

**Status:** five contracts approved by the owner: Inbox item, Agent report,
Engine control channel, and Role policy (PR #2, 2026-11-08), and Project
manifest (PR #3, 2026-11-09). Role policy v2.0 and Project manifest v1.1
approved 2026-11-10 (H-0008): the role policy moved into the manifest.
Role policy v2.1 (same day, H-0008): each role lists its tools and what it
may read; secret files are denied to every role.

## Contract entry format

```
### <Name> — v<major>.<minor>
- Status: Proposed | Approved | Deprecated
- Owner decision: <link>
- Used by: <components>
- Definition: <schema, signature, or format>
- Compatibility: <what changes are breaking>
```

---

## Inbox item — v1.0

- Status: Approved
- Owner decision: follows ADR 0002
- Used by: engine, all agents that file items, VS Code extension
- Compatibility: adding an optional field is non-breaking; renaming,
  removing, or changing the meaning of a field is breaking (major version).

**Location:** `.factory/inbox/<inbox>/<id>.md`, where `<inbox>` is
`decision`, `testing`, or `hygiene`.

**Ids:** `D-0001`, `T-0001`, `H-0001`, numbered per inbox per repo.

**Format:** Markdown with YAML frontmatter. The frontmatter is what the
engine and extension read; the body is the human-readable context.

```yaml
---
schema: inbox-item/1.0
id: D-0007
inbox: decision                 # decision | testing | hygiene
title: Choose session store for login
category: Architecture          # decision inbox only: Product | Architecture | Interfaces | Assumptions | Security
priority: high                  # critical | high | medium | low  (as filed)
effective_priority: high        # what the queue sorts by; lowered on defer
blocking: true                  # keeps its value through deferral
status: open                    # open | approved | rejected | changes_requested | research_requested | deferred
feature: F-012                  # optional
created_by: orchestrator        # agent role
created_at: 2026-11-08T21:00:00Z
options:                        # decision inbox only
  - id: A
    label: Redis
  - id: B
    label: Postgres table
recommendation: A
links:                          # files, logs, diffs, transcripts
  - kind: file
    ref: docs/features/F-012-login.md
history:                        # appended on every status change, never edited
  - at: 2026-11-08T21:00:00Z
    by: orchestrator
    action: filed
---
```

Body sections by inbox (headings are fixed so the extension can render them):

| Inbox | Required body sections |
|---|---|
| decision | Context, Options (with pros and cons per option), Project impact, Recommendation, Cost of delay |
| testing | Expected, Actual, Logs, Root cause, Recovery attempts, Recommended next step |
| hygiene | File, Reason, Current content, Proposed content, Diff, Benefits, Risks, Recommendation |

**Owner actions** append to `history` with `by: owner` and one of
`approved`, `rejected`, `changes_requested`, `research_requested`,
`deferred`, `restored`, plus an optional `note`. Each action is one commit
whose message starts with the item id.

---

## Agent report — v1.0

- Status: Approved
- Owner decision: follows ADR 0001
- Used by: engine, every agent, validation judge (as evidence)
- Compatibility: as for inbox items.

**Location:** `.factory/runs/<feature>/<stage>/<role>-<n>.json`, committed on
the feature branch. Large logs and transcripts are stored outside Git and
referenced by path or URL.

**Common envelope (every role):**

```json
{
  "schema": "agent-report/1.0",
  "role": "test-engineer",
  "feature": "F-012",
  "stage": "build_and_test_prep",
  "commit": "<sha the work applies to>",
  "outcome": "complete",
  "summary": "One paragraph for the orchestrator.",
  "items_filed": ["D-0009"],
  "artifacts": [{ "kind": "log", "ref": "<path or URL>" }],
  "body": {}
}
```

`outcome` is one of `complete`, `blocked` (waiting on an inbox item),
`failed` (could not do the work), or `partial` (with the reason in `summary`).

**Role-specific `body`:**

| Role | Required fields |
|---|---|
| requirements-analyst | `spec_path`, `spec_version`, `open_assumptions` (item ids) |
| software-developer | `files_changed`, `spec_deviations`, `not_done` |
| test-engineer | `tests_run`, `passed`, `failed`, `skipped`, `criteria_map` (AC id → test ids), `failures` (test, expected, actual, log ref), `not_run` (with reason) |
| security-reviewer | `gate` (1 or 2), `findings` (criterion, severity, location, explanation, fix, blocks) |
| validation-judge | `verdict` (PASS, FAIL, NEEDS_HUMAN_REVIEW), `checklist` (area, status, evidence), `findings` (grade, location, explanation) |
| orchestrator | `gate`, `checks` (name, passed, evidence) |

---

## Engine control channel — v1.0

- Status: Approved
- Owner decision: follows ADR 0003
- Used by: VS Code extension, engine
- Compatibility: adding a method is non-breaking; changing a method's
  parameters or result is breaking.

Inbox actions do **not** go through this channel: the extension writes them
to the item files (ADR 0002), and the engine watches the files. The channel
is only for running the engine.

**Transport:** JSON-RPC 2.0 over a local named pipe (Windows) or Unix domain
socket (macOS/Linux), path written to `.factory/engine.json` when the engine
starts. Not reachable from the network.

| Method | Params | Result |
|---|---|---|
| `engine.status` | none | `{ version, uptime_s, features: [{ id, stage, active_agents }] }` |
| `engine.pause` | `{ feature? }` | `{ paused: [feature ids] }` |
| `engine.resume` | `{ feature? }` | `{ resumed: [feature ids] }` |
| `engine.shutdown` | none | `{ ok: true }` after agents reach a safe stop |
| `feature.start` | `{ request: string }` | `{ feature: id }` (assigns the requirements analyst) |

**Notifications** (engine to extension): `feature.stageChanged`,
`inbox.itemFiled`, `agent.started`, `agent.finished`.

---

## Role policy — v2.1

- Status: Approved
- Owner decision: follows ADR 0004; v2.0 and v2.1 by the owner, 2026-11-10 (H-0008)
- Used by: engine (enforces it), owner (edits it through the hygiene process)
- Compatibility: tightening a rule is non-breaking; loosening one needs a
  Security decision. v2.0 moved the policy from `.factory/policy/roles.yaml`
  in each repo into the project manifest; the rule format is unchanged.
  v2.1 added `tools` and `read`. No manifest used v2.0, so making them
  required broke nothing.

**Location:** the `policy:` key of the project manifest (change-controlled),
with optional per-repo overrides under `repos[].policy`. Effective policy
for a repo: the project's roles, where a repo override's `allow` lists
replace the project's and its `deny` lists are added to the project's.
Each role has five sections: `tools` (the agent's built-in tools: `Read`,
`Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`), `read`,
`write`, `commands` (programs `Bash` may run) and `network`. Every role must
list at least one tool and one read glob, and must deny reading secret files:
`**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`,
`**/id_rsa*`, `**/id_ecdsa*`, `**/id_ed25519*`.
Every core role must be present, and every role that may write outside
`.factory/` must deny `CLAUDE.md`, `.claude/**`, `.github/**`, `agents/**`,
`skills/**` and `workflows/**`.

```yaml
policy:
  roles:
    software-developer:
      tools:
        allow: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
      read:                      # globs relative to the worktree root
        allow: ["**"]
        deny: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ecdsa*", "**/id_ed25519*"]
      write:
        allow: ["src/**", "docs/**"]
        deny: ["tests/acceptance/**", "CLAUDE.md", ".claude/**", ".github/**", "agents/**", "skills/**", "workflows/**"]
      commands:                  # exact program names; arguments not restricted
        allow: ["npm", "node", "git"]
      network:
        allow: ["registry.npmjs.org"]
    security-reviewer:
      tools:
        allow: ["Read", "Grep", "Glob", "Write"]   # no Edit, no shell
      read:
        allow: ["**"]
        deny: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ecdsa*", "**/id_ed25519*"]
      write:
        allow: [".factory/runs/**/security-reviewer-*.json"]
      commands:
        allow: []
      network:
        allow: []
repos:
  - name: web
    policy:
      roles:
        software-developer:
          write:
            allow: ["app/**"]    # replaces the project's allow list for this repo
            deny: ["app/generated/**"]   # added to the project's deny list
```

Rules: deny wins over allow; anything not allowed is denied (a missing
section allows nothing); a role missing from the policy may not run.

---

## Project manifest — v1.1

- Status: Approved
- Owner decision: ADR 0010; requirements from the owner (2026-11-09); v1.1
  adds `policy` and `repos[].policy` (owner, 2026-11-10, H-0008)
- Used by: engine (resolves effective config), owner (edits it), VS Code extension (later)
- Compatibility: adding an optional key is non-breaking; renaming or removing one is breaking.

**Location:** `factory-project.yaml` at the root of the project's config repo.
Full format, validation rules, and an example are in
`proposals/0013-project-manifest.md`. Required top-level keys: `schema`
(`factory-project/1.0`), `name`, `factory.version`, `repos`, `maturity`.
Optional: `description`, `skills`, `agents`, `standards`, `settings`, `notes`,
`policy` (Role policy v2.0). Each entry of `repos` may carry `policy`
overrides. The manifest is the only record of repo and project maturity
levels. `schema` stays `factory-project/1.0`: v1.1 only adds optional keys.

**Protected defaults:** `security-review` and the six core agents may never
be excluded; overriding one requires a linked, approved Security decision
and may only add rules.
