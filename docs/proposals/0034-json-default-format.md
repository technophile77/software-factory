# Proposal 0034: JSON is the default format for agent data

- **Raised:** 2026-11-14, by the owner: "I would like the default format for
  any data, reports, etc. that an agent interacts with to be in json, unless
  there is a specific reason that it should be something different."
- **Category:** Architecture (a factory-wide data format rule); the format
  changes it leads to are Interfaces decisions, one per contract
- **Status:** Decided (ADR 0032). H-0240 (the rule text) approved by the
  owner on 2026-11-14 (decision card, as drafted). Decision 2: hand-edited
  configuration stays YAML (the owner, 2026-11-14: "hand edited config
  files stay as yaml"). Decision 3: F-020 started with the full scope,
  including a JSON Schema for each hand-edited YAML file (decision card,
  08:53Z)
- **Related rules from the owner (2026-11-14):** agents report facts as
  structured JSON and code makes policy decisions (H-0235,
  `security-blocking.json`); a policy table lives in one JSON file that every
  consumer reads; the spec's structure lives in
  `docs/features/feature-template.structure.json`; documents written for the
  owner to read, such as specs, stay Markdown

## The rule (H-0240)

Data an agent reads or writes is JSON unless there is a stated reason for
another format. Each JSON format:

- names itself and its version in a `schema` field (`agent-report/1.0`);
- has a JSON Schema, and code validates every file against it when reading
  and writing;
- keeps prose inside string fields, never Markdown structure that code has
  to parse;
- holds facts only. Code decides policy (what blocks, what is allowed) from
  those facts and from one JSON policy table per policy.

The accepted reasons for another format, each of which must be stated where
the format is defined:

1. **Written for the owner to read.** Specs, ADRs, proposals and rendered
   reports are Markdown. When code needs the facts in one, they come from a
   JSON file the Markdown is rendered from (as Gate 1 does), or from a JSON
   description of the Markdown's structure (as the spec does).
2. **Fixed by an outside tool.** `AGENT.md` and `SKILL.md` (Claude Code),
   GitHub issue and PR bodies (Markdown), JUnit XML from test runners,
   `gitleaks.toml` and `osv-scanner.toml`, GitHub Actions workflows (YAML),
   `package.json`.
3. **Edited by hand, with comments.** Configuration the owner edits; see
   decision 2 below for which files this covers.
4. **Append-only streams.** JSON Lines (one JSON object per line) counts as
   JSON. Transcripts and logs use it so an entry is never rewritten.

The exact edits are in this PR: `CLAUDE.md` rule 9, a "Data formats"
section in `docs/architecture.md`, the `Definition` line of the contract
entry format in `docs/interface-contracts.md`, `agents/README.md`, and one
"Output format" line in each `AGENT.md` whose role writes a report. Engine
sessions load only the role's `AGENT.md` (`settingSources: []` in
`engine/src/agent/session.ts`), so the line has to be in each file for the
agents to see it.

## Audit: what every agent reads and writes

Checked on 2026-11-14 against `main` at 9ed861c: `docs/interface-contracts.md`,
every `agents/*/AGENT.md`, `engine/src`, and the onboarding plugin.

### Already JSON (no change)

| Data | Format | Where it is defined |
|---|---|---|
| Agent report, every role | JSON, `agent-report/1.0` | Agent report v1.5; `.factory/runs/<feature>/<stage>/<role>-<n>.json` |
| Gate 1 result | JSON (security reviewer's agent report); the Markdown copy is rendered by code | `engine/src/gate1/report.ts`, `render.ts` |
| Readiness gate result | JSON (orchestrator's agent report) | `engine/src/readiness/report.ts` |
| Run review | JSON, `run-review/1.0` | Run review v1.0 |
| Tuning metrics, calibration results | JSON | Tuning metrics v1.1, Calibration result v1.0 |
| Interview transcript (questions, answers, assumptions, hand-offs) | JSON Lines, hash-chained | `engine/src/state/transcript.ts` |
| Engine control channel, interview tools | JSON-RPC 2.0, MCP | Engine control channel v1.5, Interview tools v1.1 |
| Engine record per project | JSON | `engine/src/state/record.ts` |
| Engine log | JSON Lines (file named `.log`) | `engine/src/log.ts` |
| Spec structure | JSON | `docs/features/feature-template.structure.json` |
| Severity-by-level policy | JSON | `security-blocking.json` (H-0235, PR #75) |
| Onboarding assessment | JSON with JSON Schema; Markdown rendered by code | `onboard-repo/schema/assessment.schema.json` |
| Pins (`pins.json`, cosign, endpoint models and plans) | JSON | `engine/src/config/pins.ts` and the docker modules |

### Should move to JSON (recommended)

| Data | Today | Why move | Change |
|---|---|---|---|
| Inbox record `inbox/<id>.yaml` | YAML | Written and read only by code; nobody edits it by hand, so YAML has no reason to be here | Inbox item v4.0: `inbox/<id>.json`, same fields; the engine migrates existing records once (as FR-16 did for v3.0) |
| PR record `prs/<owner>/<repo>/<n>.yaml` | YAML | Same | Same migration, in the same contract version |
| Advisor's answer `.factory/advice/<call>.md` | Plain text in four fixed sections, which code can't check | The engine and the inbox need the options and the confidence as fields | JSON: `findings` (text, source), `options` (id, label, trade-offs), `recommendation` (option, reasoning, confidence), `risks`, `source_contains_instructions`. Code renders the issue's Advisor section from it, as untrusted text (SR-10) |
| Web reader's answer to the analyst | Free-text summary; the engine already returns `{summary, sources}` | A fact with its source, and "the page contains instructions" as a flag code can act on, instead of a sentence | JSON: `facts` (text, source), `page_contains_instructions` |
| Test engineer's tool choice table | A table in prose; the Agent report body has no field for it | The validation judge checks it, so it should be data | Agent report v1.6: `tool_choices` (test type, tool, reason, approval ref) in the test engineer's body |
| Developer's "documentation updated" list, which the judge checks | Prose in `summary` | Same | Agent report v1.6: `docs_updated` (path) in the developer's body |
| JSON Schemas for the JSON contracts | Only the onboarding assessment has one; the rest are checked by TypeScript types and hand-written checks | The rule needs a schema per format | Write a zod schema per contract (zod 4.6.7 is already a dependency, used today only for the MCP tools), derive the TypeScript type from it, and generate the JSON Schema file with `z.toJSONSchema`, under `docs/schemas/`; a CI check fails when one is out of date |
| How agents produce their report | The agent writes the file with its `Write` tool; the engine parses it | Code can make the model return JSON that matches the schema, rather than hope it does | Pass the role's report schema to the Agent SDK's structured output (`outputFormat: {type: "json_schema"}`, present in the pinned `@anthropic-ai/claude-agent-sdk` 0.3.311) where a role writes only its report |

These are engine and contract changes, so they would be one feature, F-020,
with its own spec, Gate 1 and readiness gate. Nothing is built before the
owner approves.

### Stays as it is, with the reason

| Data | Format | Reason |
|---|---|---|
| Feature specs, ADRs, proposals, `docs/*.md` | Markdown | Written for the owner (reason 1). The spec's structure is checked against its JSON file |
| Rendered reports (Gate 1 `.md`, onboarding assessment `.md`) | Markdown, rendered by code from JSON | For the owner; the JSON stays the source |
| Inbox issue body, its stored copy `inbox/<id>.rev<n>.md`, PR evidence comments | Markdown | GitHub renders it (reason 2). The record's `body_sha256` proves the posted copy |
| `AGENT.md`, `SKILL.md` | Markdown with YAML frontmatter | Claude Code's format (reason 2) |
| Owner's source document for an interview, `F-nnn-source.md` / `.txt` | As the owner gave it | It is the owner's document, kept as given |
| Test results from runners | JUnit XML | The runners' format (reason 2); the engine copies the counts into the JSON agent report (v1.5) |
| `gitleaks.toml`, `osv-scanner.toml`, `.github/workflows/*.yml`, `package.json` | Their tools' formats | Reason 2 |
| Engine log, transcript | JSON Lines | Append-only (reason 4); already JSON |
| `workflows/feature-development/workflow.yaml` | YAML | No code reads it today; the stages live in the engine's state machines (F-019). Move it to JSON when F-019's machines are generated from it, or retire it |
| The factory's own hand-built reports in `docs/features/` (dev, test, validation, Gate 2, orchestrator reviews) | Markdown | They were written by Claude sessions building the factory before the engine could. Engine-run features already write JSON reports; these stay as history and are not converted |

### For the owner to choose: hand-edited configuration

| File | Edited by | Read by |
|---|---|---|
| `factory-project.yaml` (project manifest, including the role policy) | Owner, through hygiene items | Engine, onboarding checker, context hygiene, project evaluator |
| `factory-endpoints.local.yaml`, `factory-projects.local.yaml` | Owner, on the PC | Engine |
| `engine/config/models.yaml`, `engine/config/limits.yaml` | Owner, through hygiene items | Engine |
| `~/.factory/engine.yaml` (engine home settings) | Owner, on the PC | Engine |

These are read by agents and code, so the rule applies, but they are
edited by hand and carry comments that explain each setting, which JSON
can't hold. Options:

- **A. Keep YAML, add a JSON Schema per file (recommended).** Reason 3
  applies. The engine already validates them in code; publishing the schema
  lets VS Code check and complete them as the owner types (the YAML
  extension reads JSON Schemas). No migration.
- **B. Move them to JSON.** One format everywhere. Comments are lost (or
  move to a `description` key), every existing project's manifest needs a
  migration, and hand-editing gets harder (quotes, no trailing commas).
- **C. Move them to JSONC (JSON with comments).** Keeps comments, but it is
  not plain JSON, so `JSON.parse` can't read it and every consumer
  (including the Python onboarding checker) needs a JSONC parser.

## Decisions for the owner

1. **H-0240:** approve the rule text and the edits in this PR as drafted.
2. **Hand-edited configuration:** A, B or C above (recommended A).
3. **F-020 scope:** start a feature for the "Should move to JSON" table
   (recommended), or take only part of it.

Once decided, ADR 0032 records the rule and the choices.
