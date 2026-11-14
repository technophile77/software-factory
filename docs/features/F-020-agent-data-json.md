# Feature: The rest of the agents' data moves to JSON, with schemas

- **Id:** F-020
- **Status:** In review
- **Requested by / date:** owner, 2026-11-14 ("I would like the default format for any data, reports, etc. that an agent interacts with to be in json, unless there is a specific reason that it should be something different"; proposal 0034 decision 3, "Start F-020, full scope", decision card 08:53Z)
- **Spec version:** 2

## 1. Objective and business purpose

H-0240 made JSON the default for anything an agent reads or writes, and
proposal 0034 audited every format. Most agent data is already JSON. This
feature moves the remaining items, gives every JSON format a schema that
code checks, and makes the model return schema-valid reports, so code (not
the model's good behaviour) guarantees the shape of what agents hand over.
It also gives the YAML files the owner edits by hand a schema, so mistakes
show up as he types instead of when the engine starts.

## 2. Expected behavior

The owner sees little change. Inbox issues, the Gate 1 report and the
advisor's answer look as they do today, because code renders them from
JSON. A report that doesn't match its schema is refused by the engine with
the field that failed, instead of being half-read. When the owner edits
`factory-project.yaml` or another hand-edited config file in VS Code, a
wrong key or value is underlined with the reason (if OQ-1 is answered yes).
Behind the scenes, inbox records are JSON files, each agent's report is the
session's structured result rather than a file the agent writes, and CI
fails when a schema file is out of date with the code.

## 3. Functional requirements

| Id | Requirement |
|---|---|
| FR-1 | Every JSON format in `docs/interface-contracts.md`, plus the advisor and web reader answers (FR-6, FR-7), has a zod schema in engine source. The TypeScript type is derived from it (`z.infer`), replacing the hand-written interface and checks it duplicates |
| FR-2 | A script writes one JSON Schema file per format to `docs/schemas/<name>-<major>.schema.json` with `z.toJSONSchema`. A test fails when a committed schema file differs from what the script writes |
| FR-3 | The engine validates every JSON file and message against its schema when reading and before writing. A file that fails is refused: the error names the file and the first failing field, and the engine handles it as that format's existing "unreadable" path does today (no partial reads) |
| FR-4 | Inbox records are JSON: `inbox/<id>.json`, schema `inbox-record/4.0`, same fields as v3.1. A one-time script, `engine/scripts/migrate-inbox-json-once.ts`, converts each `inbox/<id>.yaml` on a project's config repo `factory/state` to `.json` in one commit per item, keeping its history unchanged, and prints any file it can't read. The engine never reads `.yaml` records. The script is deleted once the owner's projects are migrated (as F-011 FR-16) |
| FR-5 | PR records (Inbox item contract, `prs/<owner>/<repo>/<n>`) are defined as JSON (`pr-record/1.0`) before F-015 builds them; nothing to migrate |
| FR-6 | The advisor returns JSON (`advisor-answer/1.0`): `findings` (text, source), `options` (2 to 4: id, label, trade_offs), `recommendation` (option id, reasoning, confidence low / medium / high), `risks` (text), `source_contains_instructions` (boolean, with `where` when true). The engine stores it at `.factory/advice/<call>.json` and renders the inbox issue's Advisor section from it as untrusted text (F-011 SR-10) |
| FR-7 | The web reader returns JSON (`web-reader-answer/1.0`): `facts` (text, source address), `page_contains_instructions` (boolean, with the address when true). The engine keeps only sources it fetched (as today), and `research_web` returns this shape to the analyst |
| FR-8 | Agent report v1.6 adds to the test engineer's body `tool_choices` (test type, tool, reason, approval ref or null) and to the developer's body `docs_updated` (path). The validation judge reads them instead of prose |
| FR-9 | Each engine-run agent session is given its report schema as the Agent SDK's structured output (`outputFormat: { type: "json_schema", schema }`). The engine takes the report from the session's structured result, validates it (FR-3) and writes the report file itself. A session that ends without a valid result is a failed run with the reason, as a missing report is today |
| FR-10 | With FR-9 in place, roles whose only write was their report (security reviewer at Gate 1, readiness orchestrator) lose the `Write` tool and their report write rule (a tightening of their run policy) |
| FR-11 | Each hand-edited YAML config file has a JSON Schema in `docs/schemas/` from the engine's zod schema for it: project manifest (including the role policy), `factory-endpoints.local.yaml`, `factory-projects.local.yaml`, `engine/config/models.yaml`, `engine/config/limits.yaml`, `engine.yaml`. The files stay YAML (proposal 0034 decision 2) |
| FR-12 | VS Code checks those files against their schemas as the owner types, per OQ-1. The onboarding template `factory-project.yaml` carries the schema reference the chosen option needs |
| FR-13 | The advisor's and web reader's `AGENT.md` describe the JSON answer in place of plain text, and gain the "Output format" line other roles got in H-0240 |

## 4. Acceptance criteria

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given the engine source, when the format inventory test runs, then every JSON format in `interface-contracts.md` and FR-6, FR-7 maps to one zod schema, and no hand-written interface for the same format remains | FR-1 |
| AC-2 | Given a zod schema changed without rerunning the schema script, when the tests run, then they fail naming the stale file; after running it, they pass | FR-2 |
| AC-3 | Given an agent report with `outcome: "done"` (not in the enum), when the engine reads it, then it is refused, the error names the file and `outcome`, and nothing from it is used | FR-3 |
| AC-4 | Given an inbox record about to be written with a missing `status`, when the engine writes it, then the write is refused before any commit | FR-3 |
| AC-5 | Given a config repo `factory/state` with three `inbox/*.yaml` records, one of them unreadable, when the migration script runs, then two `.json` records exist with the same fields and history, two `.yaml` files are gone (one commit each), and the unreadable one is printed and left as is | FR-4 |
| AC-6 | Given `inbox/D-0001.yaml` and no `.json`, when the engine starts, then it does not read the YAML record | FR-4 |
| AC-7 | Given an advisor session whose structured result has `confidence: "certain"`, when the engine reads it, then the call fails with the reason and nothing is added to the issue; given a valid result, then the issue's Advisor section shows each field as escaped plain text | FR-6, FR-9 |
| AC-8 | Given a web reader result with `page_contains_instructions: true`, when the analyst calls `research_web`, then the result carries the flag and the address, and a fact whose source the reader didn't fetch is dropped | FR-7 |
| AC-9 | Given a test engineer report without `tool_choices`, when the engine reads it, then it is refused; given one with it, the judge's evidence checklist reads the tool choices from that field | FR-8 |
| AC-10 | Given a Gate 1 run, when it completes, then the report file was written by the engine from the structured result, and the reviewer's session had no `Write` tool | FR-9, FR-10 |
| AC-11 | Given a session that ends without a structured result, when the run ends, then it is recorded as failed with "no report" and offered for a rerun (F-019 FR-4) | FR-9 |
| AC-12 | Given each hand-edited YAML file's example in the repo, when the schema test runs, then each validates against its schema, and a copy with one unknown top-level key fails | FR-11 |
| AC-13 | Given the onboarding template, when a new project is onboarded, then its `factory-project.yaml` carries the schema reference from FR-12 | FR-12 |
| AC-14 | Given `scripts/check_docs.py`, when it runs, then it fails if the advisor's or web reader's `AGENT.md` lacks the "Output format" line | FR-13 |

## 5. Constraints

- No new runtime dependency: zod 4.6.7 is already pinned in `engine/package.json`; `z.toJSONSchema` is part of it.
- Agent SDK 0.3.311 (pinned) has `outputFormat`; no SDK upgrade.
- Hand-edited config stays YAML (proposal 0034 decision 2).
- Markdown the owner reads (specs, rendered reports, issue bodies) is unchanged (H-0240 reason 1).
- Rapid prototype: CI is advisory; tests related to the change run locally before the PR.

## 6. Edge cases

- A record written by an engine version from before this feature (`.yaml`) while the engine is stopped: left for the migration script; the engine never reads it (AC-6).
- A record whose JSON is valid but whose schema version is newer than the engine knows: refused (FR-3) with the version named, never guessed.
- A model that can't satisfy the schema within its turn limit: a failed run with "no report" (AC-11), not a retry loop.
- An endpoint rung (F-013, LiteLLM) whose model doesn't support structured output: see A-2.
- An advisor or web reader answer that embeds Markdown or HTML inside a string: shown as escaped plain text (SR-10 of F-011), never rendered.
- A config file with comments: schemas don't touch comments; YAML stays as the owner wrote it.

## 7. Dependencies

H-0240 and proposal 0034 (merged, PR #76). F-011 (inbox records), F-006 (advisor), F-005 / F-009 (web reader, `research_web`), F-013 (endpoint rungs), F-015 (PR records, build stage), F-019 (run machine: a failed run offers a rerun). The build touches `engine/src/engine.ts`.

## 8. Assumptions

| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Existing inbox records are moved by a one-time script run from the owner's PC, as F-011 FR-16 did, not by engine code | Owner's F-011 choice (2026-11-13) followed | Pending |
| A-2 | A role running on a model endpoint without structured output support falls back to writing its report file as today, still validated by FR-3; the fallback is recorded in the report's `fallback` field | | Pending |
| A-3 | The Agent SDK's structured output works with multi-turn tool use for every role; checked by a spike test at the start of the build, and if it fails for a role, that role uses A-2's fallback | | Pending |

## 9. Security considerations

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Schema validation is the boundary check for every agent result and every record read from `factory/state` (S1.1, S4.5); it replaces casts such as `YAML.parse(...) as InboxRecord` | analyst | Proposed |
| SR-2 | String length limits in each schema match today's limits (for example the web reader's summary cap) so a JSON answer can't carry more than the text it replaces | analyst | Proposed |
| SR-3 | Advisor and web reader strings are untrusted data: rendered only as escaped plain text and never used as commands, paths or URLs except a web reader source the engine fetched itself (S6.1, S9.3) | analyst | Proposed |
| SR-4 | While any `inbox/*.yaml` exists on a project's `factory/state`, the engine starts no feature work and files no item for that project, and tells the owner to run the migration script; `nextId` counts `.yaml`, `.json` and `.md` files | Gate 1 #1 | Proposed |
| SR-5 | The migration script checks each YAML record against `inbox-record/3.0` (id equal to the file name, default core schema, alias cap) before converting it; prints failures by path and reason only and leaves them in place; never overwrites an existing `.json`; adds a `migrated` history entry with the old path and commit; pushes fast-forward only and stores no credentials | Gate 1 #2 | Proposed |
| SR-6 | Every schema is strict (unknown keys refused, not stripped) and caps every array and the file's byte size before parsing. The engine validates only with the zod schemas in its own source, never a schema file read at run time or named in the data. A refusal names the field path, never its value | Gate 1 #3 | Proposed |
| SR-7 | The engine takes a report only from the structured output of a successful SDK `result` message. The model's schema leaves out every engine-filled field (`blocks`, `model`, `usage`, `rung`, `fallback`, test run counts), and a result containing one is refused. Roles under FR-10 get no report folder mount | Gate 1 #4 | Proposed |
| SR-8 | The advisor's options are shown only inside the untrusted Advisor section, with ids that can't be read as the item's options ("Advisor option 1"); they never become action comments or `/choose` targets | Gate 1 #5 | Proposed |
| SR-9 | The record keeps the SHA-256 of the exact bytes of `.factory/advice/<call>.json`, and the issue keeps the existing match or mismatch line | Gate 1 #6 | Proposed |
| SR-10 | `source_contains_instructions` and `page_contains_instructions` are the agent's own claim: true shows a warning, false relaxes no check; `where` is untrusted text under SR-3, and the `research_web` result keeps its untrusted label | Gate 1 #7 | Proposed |
| SR-11 | The engine decides A-2's fallback from the endpoint's declared capability, never from the agent; it grants `Write` only to the run's one report path and records the fallback in a field other than v1.4's `fallback` | Gate 1 #8 | Proposed |
| SR-12 | Only if OQ-1 (a) is chosen: the S4.1 review and CVE check are recorded with the Architecture decision; the extension version is pinned with auto-update off; the `$schema` reference names a commit SHA or a local path, never a tag; SchemaStore and the extension's telemetry are off in the workspace settings; the schema host is listed as a read-only external service; the engine ignores the `$schema` line | Gate 1 #9 | Proposed |

## 10. Interface requirements

Each change is an Interfaces decision, applied with the build once approved:

| Id | Contract | Change |
|---|---|---|
| H-0241 | Inbox item v4.0 (breaking) | Records at `inbox/<id>.json`, schema `inbox-record/4.0`; PR records `prs/<owner>/<repo>/<n>.json`, schema `pr-record/1.0`; advice file `.factory/advice/<call>.json` (FR-4, FR-5, FR-6) |
| H-0242 | Agent report v1.6 (additive) | `tool_choices`, `docs_updated` (FR-8); the report is the session's structured result and the engine writes the file (FR-9) |
| H-0243 | New: Advisor answer v1.0, Web reader answer v1.0; Interview tools v1.2 (`research_web` result shape) | FR-6, FR-7; `agents/advisor/AGENT.md` and `agents/web-reader/AGENT.md` updated (FR-13) |
| H-0244 | Role policy v2.8 (tightening) and `docs/schemas/` | Gate 1 reviewer and readiness orchestrator lose `Write` (FR-10); schema files and their CI check (FR-2, FR-11); onboarding template schema reference (FR-12) |

## 11. Readiness gate

- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-14 | Draft from proposal 0034 (decisions 2 and 3) | (pending) |
| 2 | 2026-11-14 | Security Gate 1 filed; SR-4 to SR-12 proposed | (pending) |

## 13. Open questions

| Id | Question | Recommendation |
|---|---|---|
| OQ-1 | How should VS Code check the hand-edited YAML files? (a) Install Red Hat's YAML extension (`redhat.vscode-yaml`), an external component that needs an S4.1 review and an Architecture decision, with a `# yaml-language-server: $schema=<URL of the schema at the factory's release tag>` line at the top of each file; (b) no editor check: the schemas are used by the engine and the onboarding checker only | (a): it's the only way to get the as-you-type check the owner's card included; the review is done before it's approved |
