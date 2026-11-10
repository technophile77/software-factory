# Interface contracts

Approved interfaces between the factory's components, and between agents.
Nothing here changes without an approved decision in the **Interfaces**
category. Each change updates this file, the implementation, the tests, and
every dependent component together.

**Status:** five contracts approved by the owner: Inbox item, Agent report,
Engine control channel, and Role policy (PR #2, 2026-11-08), and Project
manifest (PR #3, 2026-11-09). Agent report v1.1 and three tuning contracts
(Run review, Tuning metrics, Calibration result) approved 2026-11-10 (F-002 A-8, H-0013).
Role policy v2.0 and Project manifest v1.1 approved 2026-11-10 (H-0008): the
role policy moved into the manifest. Role policy v2.1 (same day, H-0008): each
role lists its tools and what it may read; secret files are denied to every role.
Its tightening after the F-003 security re-reviews (longer protected and secret
lists, no shells as commands, no globs leaving the worktree) approved by the
owner 2026-11-10 (decision card). Engine control channel v1.1 (H-0022) and Role policy v2.2 (H-0023) for F-005
approved by the owner 2026-11-10 (decision card, as drafted).

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

## Agent report — v1.1

- Status: Approved
- Owner decision: follows ADR 0001; v1.1 adds optional fields (F-002 A-8)
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

**Optional envelope fields (v1.1):** `model`, `effort`, `rung`,
`usage` (`input_tokens`, `output_tokens`, `cost_usd`, `duration_s`), and
`transcript_ref` (where the run's transcript is kept, outside Git). The
engine fills them; agents do not.

**Role-specific `body`:**

| Role | Required fields |
|---|---|
| requirements-analyst | `spec_path`, `spec_version`, `open_assumptions` (item ids) |
| software-developer | `files_changed`, `spec_deviations`, `not_done` |
| test-engineer | `tests_run`, `passed`, `failed`, `skipped`, `criteria_map` (AC id → test ids), `failures` (test, expected, actual, log ref), `not_run` (with reason) |
| security-reviewer | `gate` (1 or 2), `findings` (criterion, severity, location, explanation, fix, blocks) |
| validation-judge | `verdict` (PASS, FAIL, NEEDS_HUMAN_REVIEW), `checklist` (area, status, evidence), `findings` (grade, location, explanation) |
| orchestrator | `gate`, `checks` (name, passed, evidence) |
| project-evaluator | `scope` (project or feature), `complexity` (simple, moderate, complex), `predictions` (role → rung, reason) |

---

## Engine control channel — v1.1

- Status: Approved
- Owner decision: follows ADR 0003; v1.1 by the owner, 2026-11-10 (H-0022, F-005)
- Used by: VS Code extension, engine, `spec-interview` skill (F-005)
- Compatibility: adding a method is non-breaking; changing a method's
  parameters or result is breaking.

Inbox actions do **not** go through this channel: the extension writes them
to the item files (ADR 0002), and the engine watches the files. The channel
is only for running the engine and, from v1.1, for the owner's answers to
the requirements analyst's interview questions. Other approvals still go to
the inbox.

**Transport:** JSON-RPC 2.0 over a local named pipe (Windows) or Unix domain
socket (macOS/Linux), path written to `.factory/engine.json` when the engine
starts. Not reachable from the network. `engine.json` is never committed.

**Access (v1.1):** the engine creates the Unix socket with mode 0600 inside
an owner-only directory, and accepts only peers running as the owner's uid.
On Windows the pipe has an unguessable `\\.\pipe\` name, is created with
`FILE_FLAG_FIRST_PIPE_INSTANCE` and an owner-only ACL, and the engine checks
the client's SID. Clients check the server is the owner too: `SO_PEERCRED` or
`getpeereid` on Unix, the server SID on Windows, opening the pipe with
`SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` and refusing any path that
is not a local `\\.\pipe\` one. The engine refuses connections from agent
processes it started. Agents running as the owner's user can still connect at
Rapid prototype; that risk is accepted by the owner until Alpha (F-005 SR-5).

| Method | Params | Result |
|---|---|---|
| `engine.status` | none | `{ version, uptime_s, features: [{ id, stage, active_agents }] }` |
| `engine.pause` | `{ feature? }` | `{ paused: [feature ids] }` |
| `engine.resume` | `{ feature? }` | `{ resumed: [feature ids] }` |
| `engine.shutdown` | none | `{ ok: true }` after agents reach a safe stop |
| `feature.start` | `{ request: string }` | `{ feature: id }` (assigns the requirements analyst) |
| `interview.list` | none | `{ features: [{ id, title, open, deferred, pending_assumptions }] }` (v1.1) |
| `interview.next` | `{ feature }` | `{ item: Item \| null }`, deferred items first; takes the feature's session lock (v1.1) |
| `interview.reply` | `{ feature, item, revision, reply_id, kind, text }` | `{ status, next?: Item }` (v1.1) |
| `interview.state` | `{ feature, item }` | `{ status, revision, recorded_at? }` (v1.1) |
| `interview.close` | `{ feature }` | `{ ok: true }`, releases the session lock (v1.1) |

`Item` (v1.1) is `{ id, revision, kind: "question" | "assumption", text, why,
suggested?, options?: [string], findings?: [{ text, source }], status }`.
`status` is `open`, `deferred`, `researching`, `answered`, `approved`,
`rejected` or `superseded`. Reply `kind` is `answer`, `more_info`, `defer`,
`approve_assumption` or `reject_assumption`; the two assumption kinds apply
only to assumption items, and the others only to questions. `text` is the
owner's words, unchanged; the engine records it as written.

Interview rules (v1.1):
- One session per feature: the lock belongs to the connection that called
  `interview.next`, and other connections get error `busy` with the time the
  session started. The lock is released when its connection closes, on
  `interview.close`, or after 30 minutes idle.
- A reply naming a revision other than the item's current one gets error
  `stale`. A repeated `reply_id` returns the first result and changes nothing.
- Only the engine writes the transcript, under `.factory/interviews/<feature>/`
  on `factory/state`, append-only. Before committing it the engine runs the
  secrets scan and blocks the commit on a hit.
- Ids match `^[A-Za-z0-9_-]{1,64}$`. Errors carry `code` and `message`;
  clients don't show `data`.
**Notifications** (engine to client): `feature.stageChanged`,
`inbox.itemFiled`, `agent.started`, `agent.finished`, and from v1.1
`interview.itemReady { feature, item }` when `more_info` research finishes.

---

## Role policy — v2.2

- Status: Approved
- Owner decision: follows ADR 0004; v2.0 and v2.1 by the owner, 2026-11-10
  (H-0008); the widenings in v2.2 approved in substance by the owner,
  2026-11-10 (F-005 OQ-2, OQ-4) and as drafted (H-0023, decision card)
- Used by: engine (enforces it), owner (edits it through the hygiene process)
- Compatibility: tightening a rule is non-breaking; loosening one needs a
  Security decision. v2.0 moved the policy from `.factory/policy/roles.yaml`
  in each repo into the project manifest; the rule format is unchanged.
  v2.1 added `tools` and `read`. No manifest used v2.0, so making them
  required broke nothing. v2.2 adds the `Skill` tool, the open-web network
  rule for a role with no file tools, the optional `web-reader` role, and
  denies every role the engine's channel file; manifests on v2.1 must add
  the two new deny entries.

**Location:** the `policy:` key of the project manifest (change-controlled),
with optional per-repo overrides under `repos[].policy`. Effective policy
for a repo: the project's roles, where a repo override's `allow` lists
replace the project's and its `deny` lists are added to the project's.
Each role has five sections: `tools` (the agent's built-in tools: `Read`,
`Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`, and from
v2.2 `Skill`, which loads only the master factory's shared skills), `read`,
`write`, `commands` (programs `Bash` may run) and `network`. Every role must
list at least one tool. Every role with a file tool (`Read`, `Grep`, `Glob`,
`Edit`, `Write`, `Bash`, `Skill`) must list at least one read glob. Every role
must deny reading secret files and, from v2.2, the engine's channel file:
`**/.env`, `**/.env.*`, `**/.envrc`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/*.jks`, `**/*.keystore`, `**/id_rsa*`, `**/id_dsa*`, `**/id_ecdsa*`, `**/id_ed25519*`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/.git-credentials`, `**/*.tfvars`, `**/credentials*.json`, `**/*.tfstate`, `**/*.tfstate.*`, `**/.aws/credentials`, `**/.docker/config.json`, `**/*.ppk`, `**/kubeconfig`, `**/.kube/config`, `.factory/engine.json`, `**/.factory/engine.json`.
Every core role must be present, and every role that may write outside
`.factory/` must deny the change-controlled paths: `CLAUDE.md`, `**/CLAUDE.md`, `CLAUDE.local.md`, `**/CLAUDE.local.md`, `.claude/**`, `.mcp.json`, `.github/**`, `.gitignore`, `.gitattributes`, `.husky/**`, `.pre-commit-config.yaml`, `lefthook.yml`, `osv-scanner.toml`, `agents/**`, `skills/**`, `plugins/**`, `.claude-plugin/**`, `workflows/**`, `**/.claude/**`, `.envrc`, `**/.envrc`, `.git`, `.git/**`, `.gitmodules`, `.vscode/**`, `.devcontainer/**`. Globs are relative to the worktree: no absolute paths, `\`, or segments
that can match `..`; brace expansion, negated classes (`[!`, `[^`) and
extglobs are refused because glob dialects read them differently.
`commands` may not name a shell, interpreter or command wrapper. That is a
guard rail, not the boundary: build and test tools run repo code by design,
so arguments are not restricted. A repo override may not add tools.
`network.allow` lists host names. From v2.2 the single entry `"*"` means any
host, and is allowed only for a role whose tools are `WebFetch` and
`WebSearch` alone, so open web content never reaches an agent that can see
project files (F-005 SR-17).

**Web reader (v2.2, optional role).** Fetches and summarizes web pages for
another agent. The engine strips hidden content (HTML comments, script and
style, hidden elements, zero-width and bidi characters, metadata) before the
reader sees a page; the reader returns plain text with the source address,
which the caller treats as untrusted data. The engine logs every address and
search. Its policy is fixed:

```yaml
    web-reader:
      tools:
        allow: ["WebFetch", "WebSearch"]
      read:
        allow: []
        deny: [<the secret files above>]
      write:
        allow: []
      commands:
        allow: []
      network:
        allow: ["*"]
```

The requirements analyst gets `Skill` and reaches the web only through the
web reader; its own `network` stays empty. Reading other features' specs and
interview transcripts, and escalating to the advisor (F-006, once built), go
through the engine, not through new read globs.

```yaml
policy:
  roles:
    software-developer:
      tools:
        allow: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
      read:                      # globs relative to the worktree root
        allow: ["**"]
        deny: [<the secret files above>]
      write:
        allow: ["src/**", "docs/**"]
        deny: ["tests/acceptance/**", <the change-controlled paths above>]
      commands:                  # exact program names; arguments not restricted
        allow: ["npm", "node", "git"]
      network:
        allow: ["registry.npmjs.org"]
    security-reviewer:
      tools:
        allow: ["Read", "Grep", "Glob", "Write"]   # no Edit, no shell
      read:
        allow: ["**"]
        deny: [<the secret files above>]
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

**Protected defaults:** `security-review` and the six core agents (orchestrator,
requirements-analyst, software-developer, test-engineer, security-reviewer,
validation-judge) may never be excluded; overriding one requires a linked,
approved Security decision and may only add rules. The two support roles are
not protected unless the owner decides otherwise.

---

## Run review — v1.0

- Status: Approved
- Owner decision: F-002 A-8
- Used by: orchestrator (writes), engine (reads triggers), owner
- Compatibility: as for inbox items.

**Location:** `.factory/runs/<feature>/review.json`, written once a feature's
run ends. Only the engine and orchestrator write it (F-002 SR-8).

```json
{
  "schema": "run-review/1.0",
  "feature": "F-012",
  "outcome": "pr_opened",
  "derived_complexity": "moderate",
  "evaluator": { "predicted": { "software-developer": 3 }, "correct": true },
  "transcripts_proposed": [{ "role": "test-engineer", "ref": "<transcript ref>", "action": "add" }],
  "roles": [{
    "role": "software-developer",
    "rung": 3,
    "runs": 2,
    "first_try_pass": false,
    "fix_cycles": 1,
    "reruns": 0,
    "attributed_failures": [{ "cause": "product_code", "stage": "orchestrator_review", "report": "<path>" }],
    "usage": { "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "duration_s": 0 },
    "suggestions_filed": ["H-0042"]
  }]
}
```

`outcome` is `pr_opened` or `stopped` (the run ended at an inbox item).

---

## Tuning metrics — v1.0

- Status: Approved
- Owner decision: F-002 A-1, A-8
- Used by: engine (writes; orders the ladder), orchestrator and owner (read)
- Compatibility: as for inbox items.

**Location:** `.factory/tuning/metrics.json` on the project config repo's
`factory/state` branch. Only the engine writes it.

```json
{
  "schema": "tuning-metrics/1.0",
  "updated_at": "2026-11-10T00:00:00Z",
  "prices": { "source": "<url>", "as_of": "2026-11-03" },
  "roles": {
    "software-developer": {
      "ladder_order": [1, 3, 2, 4],
      "rungs": {
        "3": {
          "samples": 12, "passes": 11,
          "tokens": { "median": 0, "p90": 0 },
          "cost_usd": { "median": 0, "p90": 0 },
          "duration_s": { "median": 0, "p90": 0 },
          "by_repo": { "shop-api": { "samples": 7, "passes": 7 } }
        }
      }
    }
  }
}
```

A rung with no samples is left out of `rungs` and listed last, in seed
order, in `ladder_order`.

---

## Calibration result — v1.0

- Status: Approved
- Owner decision: F-002 A-8
- Used by: engine (writes), orchestrator (files the hygiene item), owner
- Compatibility: as for inbox items.

**Location:** `.factory/tuning/calibration/<timestamp>.json` on the project
config repo's `factory/state` branch.

```json
{
  "schema": "calibration-result/1.0",
  "reason": "initial | owner_request | step_down_check",
  "source": "master:moderate | transcripts",
  "ladder_version": "<factory tag>",
  "estimated_cost_usd": 0,
  "actual_cost_usd": 0,
  "stopped_at_cap": false,
  "roles": [{
    "role": "test-engineer",
    "tried": [{ "rung": 1, "trials": 5, "passes": 3, "tokens": 0, "cost_usd": 0, "passed": false }],
    "proposed_rung": 2
  }]
}
```
