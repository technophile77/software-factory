# Feature: The rest of the agents' data moves to JSON, with schemas

- **Id:** F-020
- **Status:** In development
- **Requested by / date:** owner, 2026-11-14 ("I would like the default format for any data, reports, etc. that an agent interacts with to be in json, unless there is a specific reason that it should be something different"; proposal 0034 decision 3, "Start F-020, full scope", decision card 08:53Z)
- **Spec version:** 4

## 1. Objective and business purpose

H-0240 made JSON the default for anything an agent reads or writes, and
proposal 0034 audited every format. Most agent data is already JSON. This
feature moves the remaining items, gives every JSON format a schema that
code checks, and makes the model return schema-valid reports, so code (not
the model's good behaviour) guarantees the shape of what agents hand over.
It also gives the YAML files the owner edits by hand a schema, which the
engine checks them against when it starts.

## 2. Expected behavior

The owner sees little change. Inbox issues, the Security and Testability Review report and the
advisor's answer look as they do today, because code renders them from
JSON. A report that doesn't match its schema is refused by the engine with
the field that failed, instead of being half-read. A wrong key or value in
`factory-project.yaml` or another hand-edited config file stops the engine
at startup with the file and field named. There is no check in the editor
(OQ-1).
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
| FR-10 | With FR-9 in place, roles whose only write was their report (security reviewer at Security and Testability Review, readiness orchestrator) lose the `Write` tool and their report write rule (a tightening of their run policy) |
| FR-11 | Each hand-edited YAML config file has a JSON Schema in `docs/schemas/` from the engine's zod schema for it: project manifest (including the role policy), `factory-endpoints.local.yaml`, `factory-projects.local.yaml`, `engine/config/models.yaml`, `engine/config/limits.yaml`, `engine.yaml`. The files stay YAML (proposal 0034 decision 2) |
| FR-12 | The engine checks each hand-edited YAML file against its schema when it starts and refuses to start a project whose file fails, naming the file and the field path. Nothing is added to VS Code and the files carry no schema reference (owner, OQ-1, 2026-11-14) |
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
| AC-10 | Given a Security and Testability Review run, when it completes, then the report file was written by the engine from the structured result, and the reviewer's session had no `Write` tool | FR-9, FR-10 |
| AC-11 | Given a session that ends without a structured result, when the run ends, then it is recorded as failed with "no report" and offered for a rerun (F-019 FR-4) | FR-9 |
| AC-12 | Given each hand-edited YAML file's example in the repo, when the schema test runs, then each validates against its schema, and a copy with one unknown top-level key fails | FR-11 |
| AC-13 | Given a `factory-project.yaml` with an unknown key under `settings`, when the engine starts, then that project is not started and the error names the file and the key's path | FR-12 |
| AC-14 | Given `scripts/check_docs.py`, when it runs, then it fails if the advisor's or web reader's `AGENT.md` lacks the "Output format" line | FR-13 |
| AC-15 | Given the engine records evidence for a managed PR, when it writes the PR record, then the file is `prs/<owner>/<repo>/<n>.json` and validates against `pr-record/1.0`, and a record missing `feature` is refused before any commit | FR-5 |

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
| A-1 | Existing inbox records are moved by a one-time script run from the owner's PC, as F-011 FR-16 did, not by engine code | Owner's F-011 choice (2026-11-13) followed | Approved (owner, 2026-11-14 09:03Z, in thread) |
| A-2 | A role running on a model endpoint without structured output support falls back to writing its report file as today, still validated by FR-3; the fallback is recorded in the report's `fallback` field | | Approved (owner, 2026-11-14 09:03Z, in thread) |
| A-3 | The Agent SDK's structured output works with multi-turn tool use for every role; checked by a spike test at the start of the build, and if it fails for a role, that role uses A-2's fallback | | Approved (owner, 2026-11-14 09:03Z, in thread) |

## 9. Security considerations

| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | Schema validation is the boundary check for every agent result and every record read from `factory/state` (S1.1, S4.5); it replaces casts such as `YAML.parse(...) as InboxRecord` | analyst | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-2 | String length limits in each schema match today's limits (for example the web reader's summary cap) so a JSON answer can't carry more than the text it replaces | analyst | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-3 | Advisor and web reader strings are untrusted data: rendered only as escaped plain text and never used as commands, paths or URLs except a web reader source the engine fetched itself (S6.1, S9.3) | analyst | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-4 | While any `inbox/*.yaml` exists on a project's `factory/state`, the engine starts no feature work and files no item for that project, and tells the owner to run the migration script; `nextId` counts `.yaml`, `.json` and `.md` files | Security and Testability Review #1 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-5 | The migration script checks each YAML record against `inbox-record/3.0` (id equal to the file name, default core schema, alias cap) before converting it; prints failures by path and reason only and leaves them in place; never overwrites an existing `.json`; adds a `migrated` history entry with the old path and commit; pushes fast-forward only and stores no credentials | Security and Testability Review #2 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-6 | Every schema is strict (unknown keys refused, not stripped) and caps every array and the file's byte size before parsing. The engine validates only with the zod schemas in its own source, never a schema file read at run time or named in the data. A refusal names the field path, never its value | Security and Testability Review #3 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-7 | The engine takes a report only from the structured output of a successful SDK `result` message. The model's schema leaves out every engine-filled field (`blocks`, `model`, `usage`, `rung`, `fallback`, test run counts), and a result containing one is refused. Roles under FR-10 get no report folder mount | Security and Testability Review #4 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-8 | The advisor's options are shown only inside the untrusted Advisor section, with ids that can't be read as the item's options ("Advisor option 1"); they never become action comments or `/choose` targets | Security and Testability Review #5 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-9 | The record keeps the SHA-256 of the exact bytes of `.factory/advice/<call>.json`, and the issue keeps the existing match or mismatch line | Security and Testability Review #6 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-10 | `source_contains_instructions` and `page_contains_instructions` are the agent's own claim: true shows a warning, false relaxes no check; `where` is untrusted text under SR-3, and the `research_web` result keeps its untrusted label | Security and Testability Review #7 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-11 | The engine decides A-2's fallback from the endpoint's declared capability, never from the agent; it grants `Write` only to the run's one report path and records the fallback in a field other than v1.4's `fallback` | Security and Testability Review #8 | Accepted (owner, 2026-11-14 09:03Z, in thread) |
| SR-12 | Withdrawn: it applied only to OQ-1 option (a), which the owner did not choose | Security and Testability Review #9 | Not applicable |

## 10. Interface requirements

Each change is an Interfaces decision. All four approved by the owner as specced, 2026-11-14 09:20Z (decision card); each is applied with its part of the build:

| Id | Contract | Change |
|---|---|---|
| H-0241 | Inbox item v4.0 (breaking) | Records at `inbox/<id>.json`, schema `inbox-record/4.0`; PR records `prs/<owner>/<repo>/<n>.json`, schema `pr-record/1.0`; advice file `.factory/advice/<call>.json` (FR-4, FR-5, FR-6) |
| H-0242 | Agent report v1.6 (additive) | `tool_choices`, `docs_updated` (FR-8); the report is the session's structured result and the engine writes the file (FR-9) |
| H-0243 | New: Advisor answer v1.0, Web reader answer v1.0; Interview tools v1.2 (`research_web` result shape) | FR-6, FR-7; `agents/advisor/AGENT.md` and `agents/web-reader/AGENT.md` updated (FR-13) |
| H-0244 | Role policy v2.8 (tightening) and `docs/schemas/` | Security and Testability Review reviewer and readiness orchestrator lose `Write` (FR-10); schema files and their CI check (FR-2, FR-11) |

## 11. Readiness gate

Checked 2026-11-14 on v4: every FR has at least one AC (AC-15 added for FR-5), A-1 to A-3 approved, SR-1 to SR-11 accepted (SR-12 withdrawn), OQ-1 answered, no deferred items. Passed.


- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit
- [x] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-14 | Draft from proposal 0034 (decisions 2 and 3) | (pending) |
| 2 | 2026-11-14 | Security and Testability Review filed; SR-4 to SR-12 proposed | (pending) |
| 3 | 2026-11-14 | OQ-1 answered (no editor check): FR-12 and AC-13 rewritten, SR-12 withdrawn | owner, decision card (OQ-1) |
| 4 | 2026-11-14 | A-1 to A-3 approved, SR-1 to SR-11 accepted; AC-15 added for FR-5; readiness gate passed | owner, 09:03Z (in thread); v4 signed off 09:04Z (decision card) |

## 13. Open questions

| Id | Question | Recommendation |
|---|---|---|
| OQ-1 | How should VS Code check the hand-edited YAML files? (a) Red Hat's YAML extension with a schema reference in each file; (b) no editor check | Answered: (b), no editor check; nothing new is installed and the engine checks the files at startup (owner, decision card, 2026-11-14) |
