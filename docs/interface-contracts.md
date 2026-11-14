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
approved by the owner 2026-11-10 (decision card, as drafted). Engine
control channel v1.2 (H-0051, owner approval of interview sessions through
GitHub, ADR 0014) approved by the owner 2026-11-10 (decision card). Role
policy v2.3 (H-0040, policies for the project evaluator and context hygiene
agents) and Agent report v1.2 (H-0041): drafts, awaiting owner approval.
Inbox item v1.1 (H-0062), Engine control channel v1.3 (H-0063, amended by
H-0075) and Role policy v2.4 (H-0061, amended by H-0076) for F-006 approved
by the owner 2026-11-10 (decision card, as drafted); the channel and policy
versions were renumbered from v1.2 and v2.3 when F-006 merged with main.
Project manifest v1.3 (H-0080), Role policy v2.5 (H-0083) and the new
Interview tools v1.0 (H-0082) for F-007 approved by the owner 2026-11-11
(decision card, as drafted after Security Gate 1). Channel v1.3 amendment
H-0084 (error code -32008 `refused`) approved by the owner 2026-11-11
(decision card). Project manifest v1.4 (`limits`, H-0087) approved by the
owner 2026-11-11 (decision card). Engine control channel v1.4 (H-0105),
Interview tools v1.1 (H-0106) and Role policy v2.6 (H-0107) for F-009 (start
an interview from a document) approved by the owner 2026-11-12 (PR #29
merged; decision card, as drafted).
Model endpoints file v1.0 (H-0135), Project manifest v1.5 (`settings.endpoints`,
H-0135) and Agent report v1.4 (H-0136) for F-013 approved by the owner
2026-11-13 (decision card). Inbox item v3.0 (F-011 H-0165, ADR 0022: items
are GitHub issues) approved by the owner 2026-11-13 (decision card); it
replaces v1.1 and the never-applied v2.0, v2.1 and Phone issue v1.0.
Inbox item v3.1 (H-0180) and Engine control channel v1.5 (H-0183) for F-016
approved by the owner 2026-11-13 (decision card).
Project manifest v1.7 (H-0193) and Agent report v1.5 (H-0194) for F-015
(build to PR) approved by the owner 2026-11-14 (decision card).

## Contract entry format

```
### <Name> — v<major>.<minor>
- Status: Proposed | Approved | Deprecated
- Owner decision: <link>
- Used by: <components>
- Definition: <schema, signature, or format>; JSON with a `schema` field and a JSON Schema unless the entry states a reason from `architecture.md` § Data formats
- Compatibility: <what changes are breaking>
```

---

## Inbox item — v4.0

- Status: Approved (v3.1); v4.0 draft, awaiting owner approval (H-0241)
- Owner decision: ADR 0022; v4.0 records as JSON (F-020 H-0241, ADR 0032), draft awaiting owner approval; v3.0 by the owner, 2026-11-13 (F-011 H-0165, decision card); v3.1 (F-016 H-0180, `effect_done` and `accepted_risk`) by the owner, 2026-11-13 (decision card). v3.0 replaces v1.1, and v2.0 (F-011 H-0120), v2.1 and Phone issue v1.0 (F-012 H-0125), which were approved but never applied.
- Used by: engine (files, reads, records), the config repo workflow (opens issues, posts action comments), Microsoft's GitHub Pull Requests extension and GitHub Mobile (view only)
- Compatibility: breaking (major) from v1.1: items are issues in the project's private config repo, not files; `pull_request` is not a kind (F-011 OQ-12); owner actions are proven by GitHub (ADR 0018, ADR 0022), not signed commits. Adding a kind, action, label or optional record field is minor; changing a template's fixed text, the marker lines or the command grammar is major. v4.0 is breaking: records move from `inbox/<id>.yaml` to `inbox/<id>.json`, moved once by a script; the fields don't change.

**Ids.** `^[DTHSMN]-\d{4,}$`: `D` decision, `T` testing, `H` hygiene, `S` spec
sign-off, `M` maturity, `N` notice. Numbered per project: the next id is one
more than the highest record of that prefix on the config repo's
`factory/state`.

**Issue** (config repo):
- Title: `<id> <Kind>[ (<Category>)]: <title>`, at most 120 characters;
  Security items use SR-19's fixed title.
- Labels: `factory-inbox`; `kind:<decision|testing|hygiene|spec|maturity|notice>`;
  `category:<product|architecture|interfaces|assumptions|security>` (decision
  only); `priority:<critical|high|medium|low>` (the effective priority);
  `blocking` when blocking.
- Assignee: the owner (`FACTORY_OWNER_LOGIN`), for every item (OQ-13).
- Body: first line `<!-- factory-item: <id> rev <n> -->`; then the kind's
  sections as fixed headings; then `Revision <n>.`. Sections: decision:
  Context, Options (numbered, with pros and cons), Project impact,
  Recommendation, Cost of delay, and Advisor when advice exists (v1.1);
  testing: Expected, Actual, Logs, Root cause, Recovery attempts, Recommended
  next step; hygiene: File, Reason, Diff, Benefits, Risks, Recommendation;
  spec: Summary, Readiness, Open items; maturity: Evidence, Gaps,
  Recommendation; notice: Details. Outside text per SR-10.

**Action comments** (workflow, in a fixed order): first line
`<!-- factory-action: <id> rev <n> <action> -->`, second line the label, for
example `Option A: Redis`, `Approve`, `Defer`, `Ask the advisor first`. For
`changes` and `research`: `<label>: reply with /changes <note>` (or
`/research <note>`).

**Owner actions.** 👍 (`+1`) on an action comment, or a comment whose first
line is a command (SR-18): `/choose <option>`, `/approve`, `/reject`,
`/defer`, `/restore`, `/dismiss`, `/advisor`, `/step <n>`, `/changes <note>`,
`/research <note>`, `/confirm <code>`. 🚀 (`rocket`) on a confirm comment
confirms. Other reactions are ignored. On a managed PR, only `/changes <note>`
is read (FR-9).

**Engine comments** (fixed texts; never start with `/`, SR-17):
`Confirm: <action> <target>. React 🚀 or reply /confirm <code> within 15 minutes.`;
`Recorded: <action>.`; `Not recorded: <reason>.` (reasons: changed since,
two actions chosen, confirm expired, comment edited, not a command, not the
owner); `Stale: revision <n> replaces this.` (edit of an old action
comment); on PRs, `Factory evidence for <feature>:` followed by the FR-9
fields.

**Record** (config repo `factory/state`, `inbox/<id>.json`, one commit per
change, message starting with the id). From v4.0 (F-020) the record is JSON
under the schema `inbox-record/4.0`, with the same fields as v3.1, shown
here in YAML form for reading. The engine checks every read and write
against the schema in `engine/src/schemas/inbox-record.ts`: unknown keys
are refused, and lists, strings and the file size are capped. A
`confirm_requested` history entry carries `chosen` (action, source,
comment_id, reaction_id, url, note), the owner action waiting for its
confirmation. v3.1 records (`inbox/<id>.yaml`) are moved once by
`engine/scripts/migrate-inbox-json-once.ts`; while any is left, the engine
runs nothing for the project (F-020 SR-4).

```yaml
schema: inbox-record/4.0
id: D-0007
kind: decision            # decision | testing | hygiene | spec | maturity | notice
title: Choose session store for login
category: Architecture    # decision only
priority: high            # as filed
effective_priority: high
blocking: true
status: open              # open | approved | chosen | rejected | changes_requested | research_requested | deferred | dismissed | closed
repo: owner/app           # the repo the item concerns, or "project"
feature: F-012            # optional
created_by: orchestrator
created_at: 2026-11-08T21:00:00Z
issue: 42                 # number in the config repo
options: [{id: A, label: Redis}, {id: B, label: Postgres table}]   # decision only
recommendation: A
links: [{kind: file, ref: docs/features/F-012-login.md}]
advisor_reason: ...       # optional, as v1.1
advice: [...]             # optional, as v1.1
revisions:                # one per revision posted
  - rev: 1
    body_sha256: <hex>
    action_comments: [{id: 1001, action: choose:A, sha256: <hex>}]
engine_comments: [1005, 1006]      # never read as commands (SR-17)
history:                           # appended, never edited
  - at: 2026-11-08T21:00:00Z
    by: engine
    action: filed
  - at: 2026-11-08T21:30:00Z
    by: owner
    action: chosen                 # chosen | approved | rejected | changes_requested | research_requested | deferred | restored | dismissed | advisor_requested | step_chosen
    option: A
    rev: 1
    source: reaction               # reaction | command
    actor_id: 1000001              # example; the real id is in the engine config
    comment_id: 1001
    reaction_id: 77
    ref: https://github.com/<owner>/<config-repo>/issues/42#issuecomment-1001
    confirmed_by: {source: reaction, comment_id: 1007, reaction_id: 78}   # risky actions only
```

Engine history actions: `filed`, `revised`, `confirm_requested`,
`auto_merged` (FR-10, with PR and merge commit), `closed`, `migrated` (FR-16,
with the old file path and commit), and from v3.1 `effect_done` (F-016 FR-2:
`effect`, the name of what the owner's last action did, and `stage`, the
feature stage it set, if any). An owner action with no later `effect_done`
is carried out when the engine next starts, once.

From v3.1, a Gate 1 risk item (`effect.type: gate1_risk`) answered with
"Accept the risk" leaves its finding in Gate 1 state `accepted_risk`: it no
longer blocks, and the spec must record it in section 9 with status
"Accepted risk", citing the finding and the item (F-016 FR-5).

**PR records** (config repo `factory/state`, `prs/<owner>/<repo>/<n>.json` from v4.0, schema `pr-record/1.0`; not yet written by the engine):
`evidence_comment_id`, `feature`, `head` at evidence time, and history
entries `evidence_posted`, `changes_requested` (with the comment id and
actor id), `merged_on_github` (merge commit, merged by), `closed_on_github`.
- F-012's approved H-0128 (manifest `phone` block) is withdrawn: the inbox
  is always on issues, so there is nothing to turn on. v19's H-0124
  (manifest `github` block) and H-0123 (`main` ruleset) stand unchanged.

**Command grammar** (F-011 SR-18): only the comment's first line, case-sensitive, matching
`^/(choose [A-Z0-9]{1,3}|approve|reject|defer|restore|dismiss|advisor|step [0-9]{1,2}|confirm [A-Z0-9]{4}|changes .+|research .+)$`.
The engine never reads its own comments as commands (F-011 SR-17).

**Advisor (from v1.1, F-006).** `advisor_reason` is set only by the orchestrator when filing; `advice` entries are written only by the engine, with the advice file at `.factory/advice/<call>.md` on `factory/state` and its sha256; the issue shows it under an **Advisor** heading, rendered as untrusted text (F-011 SR-10).

---

## Agent report — v1.5

- Status: Approved (v1.1); v1.2 draft, awaiting owner approval (H-0041);
  v1.3 Gate 1 fields approved (H-0096, owner, decision card, 2026-11-12);
  v1.4 endpoint rungs approved (H-0136, owner, decision card, 2026-11-13);
  v1.5 location and build-stage bodies approved (F-015 H-0194, owner,
  decision card, 2026-11-14)
- Owner decision: follows ADR 0001; v1.1 adds optional fields (F-002 A-8);
  v1.2 adds the context-hygiene body and `proposed_items`, requested by the
  owner 2026-11-10 (PR #17)
- Used by: engine, every agent, validation judge (as evidence)
- Compatibility: as for inbox items.

**Location:** `.factory/runs/<feature>/<stage>/<role>-<n>.json`, committed on
the project config repo's `factory/state` (v1.5, ADR 0028; never in a code
repo). Large logs and transcripts are stored outside Git and
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

**Endpoint rungs (v1.4, F-013).** `model` is either a Claude model id or
`<endpoint>/<model>` for a run on a configured model endpoint, for example
`lan/qwen3.8-27b`. The endpoint is named, never its address. For an
endpoint run, `usage.cost_usd` follows the endpoint's billing mode (F-013
FR-13: 0 for `local` and `subscription`), and optional `usage.plan_share`
(0 to 1) records a `subscription` run's share of its plan limits. Optional
`fallback` (`{ endpoint, reason, waited_s, prompt_tokens }`) records a run
that was meant for an endpoint but ran on the role's Claude rung (F-013
FR-7). Tuning metrics and Calibration result group rungs by the full
`model` string. Additive.

**Role-specific `body`:**

| Role | Required fields |
|---|---|
| requirements-analyst | `spec_path`, `spec_version`, `open_assumptions` (item ids) |
| software-developer | `files_changed`, `spec_deviations`, `not_done` |
| test-engineer | `tests_run`, `passed`, `failed`, `skipped`, `criteria_map` (AC id → test ids), `failures` (test, expected, actual, log ref), `not_run` (with reason) |
| security-reviewer | `gate` (1 or 2), `findings` (criterion, severity, location, explanation, fix, blocks (from F-016 v18 set by the engine from severity and maturity, never by the reviewer; a reviewer's value is ignored); from v1.3 optional `needs_owner`, `options` (id, label), `recommendation`); from v1.3 optional for Gate 1: `checklist` (question, answer), `permissions_added`, `abuse_cases`, `not_applicable` (criterion, reason) |
| validation-judge | `verdict` (PASS, FAIL, NEEDS_HUMAN_REVIEW), `checklist` (area, status, evidence), `findings` (grade, location, explanation) |
| orchestrator | `gate`, `checks` (name, passed, evidence); from v1.5, for the stage 6 failure classifier (F-015), `failures` (test, cause, evidence), where cause is one of the failure causes in `testing-strategy.md` |
| project-evaluator | `scope` (project or feature), `complexity` (simple, moderate, complex), `predictions` (role → rung, reason), and from v1.2 `proposed_items` |
| context-hygiene (v1.2) | `sizes` (file, tokens, budget, change since last review), `duplicates` (instruction, locations), `skill_misses` (run, skill, `not_loaded` or `not_applicable`), `conflicts` (location, explanation), `proposed_items` |

**Build stage (v1.5, F-015).** The engine runs the tests, so in the
test engineer's body the run fields (`tests_run`, `passed`, `failed`,
`skipped`, `failures`, `not_run`) are filled by the engine from the JUnit XML
results; the agent fills only `criteria_map`. Additive.

**`proposed_items` (v1.2).** Items a role with no inbox write access wants
filed: each is a complete Inbox item v1.0 without `id`, `created_at` or
`history`. The orchestrator files them unchanged, sets `created_by` to the
proposing role, and lists the new ids in its own report's `items_filed`.

---

## Engine control channel — v1.5

- Status: Approved
- Owner decision: follows ADR 0003; v1.1 by the owner, 2026-11-10 (H-0022, F-005); amendment
  H-0025 (sessions by token, framing, `engine.json` format, error codes)
  approved by the owner, 2026-11-10 (decision card); amendment H-0026
  (`busy` data, listener pid, file modes) approved by the owner, 2026-11-10
  (decision card); v1.2 (H-0051, owner approval of interview sessions through
  GitHub, ADR 0014) approved by the owner, 2026-11-10 (decision card); v1.3
  (F-006, the advisor) approved by the owner, 2026-11-10 (H-0063 and
  amendment H-0075: advisor fields stated exactly, call limits, budget flag,
  advice revision and hash; decision card, as drafted; renumbered from v1.2
  when merged with main); v1.4 (F-009, H-0105) approved by the owner, 2026-11-12 (decision card, as drafted); v1.4 capability list approved by the owner, 2026-11-12 (decision card); v1.5 (F-016 H-0183, `waiting_on`) approved by the owner, 2026-11-13 (decision card)
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
starts. Not reachable from the network. `engine.json` is never committed;
from v1.1 it is `{ "version": "1.1", "path": "<socket or pipe path>", "pid": <int> }`,
and from v1.4 it may also hold `"capabilities": [<name>, ...]`, where `pid` is the process listening on the channel (clients check it against
the peer where the OS reports one). The engine writes it with mode 0600, and
the `.factory` worktree directory must not be group- or world-writable;
clients refuse otherwise.
Framing (v1.1): one JSON-RPC message per line, UTF-8, ending in `\n`, at most
1 MiB.

**Access (v1.1):** the engine creates the Unix socket with mode 0600 inside
an owner-only directory, and accepts only peers running as the owner's uid.
On Windows the pipe has an unguessable `\\.\pipe\` name, is created with
`FILE_FLAG_FIRST_PIPE_INSTANCE` and an owner-only ACL, and the engine checks
the client's SID. Clients check the server is the owner too: `SO_PEERCRED` or
`getpeereid` on Unix, the server SID on Windows, opening the pipe with
`SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` and refusing any path that
is not a local `\\.\pipe\` one. The engine refuses connections from agent
processes it started. Agents running as the owner's user can still connect;
from v1.2 an interview session accepts replies only after the owner approves
it through GitHub (ADR 0014), and the residual risk is recorded in F-005 SR-5.

| Method | Params | Result |
|---|---|---|
| `engine.status` | none | `{ version, capabilities?, uptime_s, features: [{ id, stage, active_agents, waiting_on? }] }` (`capabilities` from v1.4; `waiting_on` from v1.5: the ids of the inbox items the feature waits on, left out when there are none) |
| `engine.pause` | `{ feature? }` | `{ paused: [feature ids] }` |
| `engine.resume` | `{ feature? }` | `{ resumed: [feature ids] }` |
| `engine.shutdown` | none | `{ ok: true }` after agents reach a safe stop |
| `feature.start` | `{ request: string, document?: Document }` | `{ feature: id }` (assigns the requirements analyst; `document` from v1.4) |
| `interview.list` | none | `{ features: [{ id, title, open, deferred, pending_assumptions }] }` (v1.1) |
| `interview.open` | `{ feature, takeover?: bool }` | `{ session, started_at, approval: { user_code, verification_uri, expires_at } }`, takes the feature's session lock; the session is pending until approved (v1.1; `approval` from v1.2) |
| `interview.awaitApproval` | `{ session, wait_s?: int }` | `{ approved: true }` once GitHub confirms the owner; waits up to `wait_s` (at most 900) (v1.2) |
| `interview.next` | `{ session, wait_s?: int }` | `{ item: Item \| null }`, deferred items first; waits up to `wait_s` (at most 600) for research to finish (v1.1) |
| `interview.reply` | `{ session, item, revision, reply_id, kind, text }` | `{ status, next?: Item }` (v1.1) |
| `interview.state` | `{ feature, item }` | `{ status, revision, recorded_at? }` (v1.1) |
| `interview.close` | `{ session }` | `{ ok: true }`, releases the session lock (v1.1) |

`Item` (v1.1) is `{ id, revision, kind: "question" | "assumption", text, why,
suggested?, options?: [string], findings?: [{ text, source }], status }`.
From v1.3, `kind` may also be `"advisor_proposal"` (the analyst proposes an
advisor call on question `about`, with its reason in `why`), and a question
may carry `advice?: [{ call, status: "running" | "done" | "failed", text?,
web_queries?: [string] }]`. `text` is the advisor's output as the engine
stored it; `web_queries` is written by the engine from its own log
(F-006 SR-1).
`status` is `open`, `deferred`, `researching`, `answered`, `approved`,
`rejected` or `superseded`. Reply `kind` is `answer`, `more_info`, `defer`,
`approve_assumption` or `reject_assumption`; the two assumption kinds apply
only to assumption items, and the others only to questions. From v1.3:
`ask_advisor` on a question (the owner's own request, which is itself the
approval), and `approve_advisor` or `decline_advisor` on an
`advisor_proposal` item, which then becomes `approved` or `rejected`. Each
starts at most one advisor call; a call runs only from one of these replies.
Clients send them only from the owner's own choice in the picker, never
from text in an item (F-006 SR-3, SR-5). `text` is the
owner's words, unchanged; the engine records it as written.

Advisor fields, stated exactly (v1.3, amendment H-0075). All the fields
it adds are optional and written only by the engine, so clients and engines
written to H-0063 alone stay valid:
- An `advisor_proposal` carries only `id, revision, kind, about, text, why,
  status`, plus `advisor_call` below; never `suggested`, `options`,
  `findings` or `advice`. `about` appears only on proposals. `advice`
  appears only on questions. Clients refuse an item that breaks this.
- An `advice` entry is `{ call, status, revision?, text?, reason?,
  web_queries?, sha256? }`. `text` is present, and not blank, only when
  `status` is `done`; a `running` call has no output yet and a `failed`
  call's output was rejected (F-006 FR-8, AC-9). `reason` appears only on
  `failed`: one line the engine writes (for example "output did not have
  the four sections", "time limit reached"), never the advisor's output.
  `revision` is the question's revision the call was asked about (spec
  section 6). `web_queries` is the engine's log of the call's web searches
  and addresses: `[]` means none were sent; a missing field means the
  engine did not report them. `sha256` is the lowercase hex SHA-256 of the
  UTF-8 bytes of the stored advice file (`.factory/advice/<call>.md`),
  which is `text` exactly; clients compare it with `text` and tell the
  owner on a mismatch (F-006 SR-4).
- A question and an `advisor_proposal` may carry `advisor_call: { limits:
  { turns, tokens, time_s, web_calls }, over_budget }`: the fixed per-call
  limits (non-negative integers) a new call on that question would run
  under, and whether it would go past the remaining project budget (F-006
  SR-8, A-1). Clients show them beside the "Ask the advisor" choice and
  the proposal, so the owner sees them before choosing; there is no extra
  confirmation step. An over-budget call still stays within ADR 0012's
  `max_usd` cap and billing-mode check (F-006 SR-12).
- A reply to an `advisor_proposal` that is no longer `open` gets `stale`
  (-32002), even at its current revision, so one proposal starts at most
  one call.
- `wait_s` on `interview.next` waits only for research (`researching`). It
  does not wait for a `running` advisor call: the question stays open, and
  clients call `interview.next` again when the owner asks.

Interview rules (v1.1):
- One session per feature. The lock belongs to the session token returned by
  `interview.open` (128 random bits, hex), not to a connection, so a client
  may use a new connection per call. Another `interview.open` gets error
  `busy` with `started_at`; with `takeover: true` it ends the old session
  instead, and the skill asks the owner before sending that. The lock is
  released on `interview.close` or after 30 minutes without a call. The token
  is a bearer token for an approved session: a process that obtains it can
  reply in that session, which is the residual risk in F-005 SR-5. Clients
  keep it out of logs and files.
- Owner approval (v1.2, ADR 0014). `interview.open` starts GitHub's device
  sign-in for the factory's OAuth app (no scopes, no client secret on the
  machine). The client shows `user_code` and `verification_uri` to the owner
  only if `user_code` matches `^[A-Z0-9]{4}-[A-Z0-9]{4}$` and
  `verification_uri` is exactly `https://github.com/login/device`; otherwise
  it stops. The engine accepts the session only when the resulting token's
  `GET /user` id equals the recorded owner id, then discards the token. Until
  then `interview.next` and `interview.reply` on the session get error
  `approval_pending`. A denied, expired or wrong-account approval, or GitHub
  staying unreachable until the code expires, ends the session with
  `approval_failed`; a poll that gets no answer is retried. A takeover
  opens a new session and needs a new approval. An approved session also
  ends 2 hours after approval.
- Within a session each deferred item is returned once, before new items;
  the engine tracks what it has shown per session.
- A reply naming a revision other than the item's current one gets error
  `stale`. A repeated `reply_id` returns the first result and changes nothing.
- Only the engine writes the transcript, under `.factory/interviews/<feature>/`
  on `factory/state`, append-only. Before committing it the engine runs the
  secrets scan and blocks the commit on a hit.
- Ids match `^[A-Za-z0-9_-]{1,64}$`; `revision` is a non-negative integer.
  Errors carry `code` and `message`; clients don't show `data`, except that
  `busy` carries `data.started_at` (ISO 8601, UTC), which clients may show
  after checking its format. Codes:
  -32001 `busy`, -32002 `stale`, -32003 unknown feature or item, -32004
  unknown or expired session, -32005 reply kind not allowed for the item,
  -32006 `approval_pending`, -32007 `approval_failed` (v1.2), -32008
  `refused` (amendment H-0084): the engine refused for a security reason,
  such as a found secret or a tampered transcript. Its message is fixed and
  reveals nothing; the reason is in a Security inbox item.

**Starting from a document (v1.4, F-009, H-0105).** `Document` is
`{ name, media_type, text, provenance }`:
- `name`: display text only, up to 200 characters, control characters
  stripped by the engine; never used in a path, commit message or git
  argument. The engine stores the file as `docs/features/F-nnn-source.md`
  (`text/markdown`) or `F-nnn-source.txt` (`text/plain`) on the feature
  branch, byte for byte, and records its SHA-256 in the transcript.
- `media_type`: `text/markdown` or `text/plain`.
- `text`: valid UTF-8, at most 262,144 bytes, no control characters other
  than tab, LF and CR.
- `provenance`: `owner` (the owner's requirements: statements count as the
  owner's answers, subject to the source confirmation) or `reference`
  (document text is only ever a suggested answer).
The engine checks every field itself and fails closed. Before storing
anything it refuses a document that contains an HTML comment, a raw HTML
tag, a zero-width or bidi character, a Markdown link reference definition
with a title or that no link uses, or a link or image with empty text
(F-009 SR-8), or in which the secrets scan finds
a secret, or whose estimated cost the remaining project budget can't cover.
A refused start creates no feature, commit, transcript entry or session.
The document can't be added or replaced after the start. An engine that
accepts `document` lists `"document"` in `capabilities`, an array of plain
names (`^[a-z][a-z0-9_]{0,31}$`, at most 32) written to `engine.json` and
returned by `engine.status`. The version alone doesn't say it: an engine may
take `document` before it serves v1.3's advisor. Clients check the list
before reading or sending a document, ignore names they don't know, and
treat a missing list as empty; an engine without the capability refuses
`document` as an unknown key. (Capability list: owner decision 2026-11-12,
decision card.)

`Item.kind` may also be `"source_confirmation"` (v1.4): `{ id, revision,
kind, sources: [{ spec_ref, section, quote, spec_line }], status }`, built
by the engine, not the analyst (F-009 SR-7); `spec_line` is the spec's own
line for `spec_ref`, copied by the engine (F-009 Gate 2 M3). Reply kinds: `confirm_sources` and
`reopen_sources`, whose `text` names the `spec_ref`s the owner wants asked
as questions. A question may carry `type?: "gap" | "conflict" |
"ambiguity"` (v1.4).

Error -32009 `document_refused` (v1.4): `data` is `{ reason: "invalid" |
"hidden_content" | "secret" | "budget", lines?: [int], rule?: string }`.
`lines` are 1-based line numbers in the document and `rule` is the secrets
scanner's rule id; neither ever carries document text. Clients may show
`data` after checking its shape.

**Notifications** (engine to client): `feature.stageChanged`,
`inbox.itemFiled`, `agent.started`, `agent.finished`, and from v1.1
`interview.itemReady { feature, item: id }` when `more_info` research finishes,
for long-lived clients; a per-call client uses `interview.next` with `wait_s`.

---

## Role policy — v2.7

- Status: Approved (v2.2); v2.3 draft, awaiting owner approval (H-0040);
  v2.4 approved (H-0061, H-0076); v2.5 approved (H-0083); v2.7 approved
  (H-0201, ADR 0026; owner, 2026-11-14, decision card, as drafted)
- Owner decision: follows ADR 0004; v2.0 and v2.1 by the owner, 2026-11-10
  (H-0008); the widenings in v2.2 approved in substance by the owner,
  2026-11-10 (F-005 OQ-2, OQ-4) and as drafted (H-0023, decision card);
  v2.3 roles requested by the owner, 2026-11-10; the advisor policy and
  request rule approved in substance by the owner, 2026-11-10 (F-006 SR-7,
  card); v2.4 approved by the owner, 2026-11-10 (H-0061 and amendment
  H-0076, the advisor denied all of `.factory/`; decision card, as drafted;
  renumbered from v2.3 when merged with main); v2.5 approved by the owner,
  2026-11-11 (H-0083, F-007 Security Gate 1 #20; decision card); v2.6
  (F-009, H-0107) approved by the owner, 2026-11-12 (decision card, as drafted)
- Used by: engine (enforces it), owner (edits it through the hygiene process)
- Compatibility: tightening a rule is non-breaking; loosening one needs a
  Security decision. v2.0 moved the policy from `.factory/policy/roles.yaml`
  in each repo into the project manifest; the rule format is unchanged.
  v2.1 added `tools` and `read`. No manifest used v2.0, so making them
  required broke nothing. v2.2 adds the `Skill` tool, the open-web network
  rule for a role with no file tools, the optional `web-reader` role, and
  denies every role the engine's channel file; manifests on v2.1 must add
  the two new deny entries. v2.3 adds two optional roles, `project-evaluator`
  and `context-hygiene`; a manifest without them stays valid, but those
  agents may not run in it. v2.4 adds the optional `advisor` role and the
  `may_request` key. Both are additions: a manifest without them is valid
  and no role can be requested, so earlier manifests need no change.
  Amendment H-0076 tightens the advisor's extra denies to all of
  `.factory/`; a manifest with an `advisor` role must replace its four
  inbox and transcript denies with the two new entries. v2.5 adds the
  engine tool `fetch_page` and gives it to the web reader in place of
  `WebFetch`; a manifest with a `web-reader` role must make that swap.
  v2.7 suspends the container rules until Beta (ADR 0026); no manifest
  changes.

**Location:** the `policy:` key of the project manifest (change-controlled),
with optional per-repo overrides under `repos[].policy`. Effective policy
for a repo: the project's roles, where a repo override's `allow` lists
replace the project's and its `deny` lists are added to the project's.
Each role has five sections: `tools` (the agent's built-in tools: `Read`,
`Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`, from
v2.2 `Skill`, which loads only the master factory's shared skills, and from
v2.5 the engine tool `fetch_page`), `read`,
`write`, `commands` (programs `Bash` may run) and `network`. Every role must
list at least one tool. Every role with a file tool (`Read`, `Grep`, `Glob`,
`Edit`, `Write`, `Bash`, `Skill`) must list at least one read glob. Every role
must deny reading secret files and, from v2.2, the engine's channel file:
`**/.env`, `**/.env.*`, `**/.envrc`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/*.jks`, `**/*.keystore`, `**/id_rsa*`, `**/id_dsa*`, `**/id_ecdsa*`, `**/id_ed25519*`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/.git-credentials`, `**/*.tfvars`, `**/credentials*.json`, `**/*.tfstate`, `**/*.tfstate.*`, `**/.aws/credentials`, `**/.docker/config.json`, `**/*.ppk`, `**/kubeconfig`, `**/.kube/config`, `.factory/engine.json`, `**/.factory/engine.json`.
Every core role must be present, and every role that may write outside
`.factory/` must deny the change-controlled paths: `CLAUDE.md`, `**/CLAUDE.md`, `CLAUDE.local.md`, `**/CLAUDE.local.md`, `.claude/**`, `.mcp.json`, `.github/**`, `.gitignore`, `.gitattributes`, `.husky/**`, `.pre-commit-config.yaml`, `lefthook.yml`, `osv-scanner.toml`, `agents/**`, `skills/**`, `plugins/**`, `.claude-plugin/**`, `workflows/**`, `**/.claude/**`, `.envrc`, `**/.envrc`, `.git`, `.git/**`, `.gitmodules`, `.vscode/**`, `.devcontainer/**`, and from
v2.6 (H-0107) the source documents the engine stores for F-009:
`docs/features/*-source.md`, `docs/features/*-source.txt`. Globs are relative to the worktree: no absolute paths, `\`, or segments
that can match `..`. **Glob dialect and matching (H-0046, owner,
2026-11-10):** a glob is literal segments separated by `/`, where `*`
matches any characters within one segment (dot files included) and `**`
matches zero or more whole segments. `?`, bracket classes, braces and
extglobs are refused, because glob libraries read them differently. Before
matching a path, the engine resolves it to its real path, following every
symbolic link (a path that doesn't exist yet resolves through its nearest
existing parent), refuses it if the result is outside the worktree, and
matches the result relative to the worktree with `/` separators, after
Unicode NFC normalization. Deny globs match case-insensitively on every
filesystem; allow globs match case-sensitively. A path counts as allowed
only if an allow glob matches and no deny glob does.
**Until Beta: no containers (v2.7, H-0201, ADR 0026).** The engine runs
each agent session on the owner's PC, as the owner's OS user, with the
session's worktree as its working folder. The container rules below are
suspended until then and must be back, under a new Security decision,
before the factory or any project it runs is promoted to Beta. These rules
still hold: the tool gate checks every file-tool read and write against
`read` and `write` (the path-matching rule above, deny wins); the engine
compares the session's branch with where it started when the session ends,
and a changed path the role's `write` rules don't allow rejects the whole
session's changes and files a Security alert; for every role except the
software developer and test engineer, `commands` limits the programs
`Bash` may run; the model credential stays in the engine's proxy,
which the session reaches as its API base URL with a dummy key. Nothing
limits what a command or the code it runs can read, write or reach on the
network: the owner accepted that risk until Beta (ADR 0026). Until Beta
the software developer and test engineer have a full shell (F-015, owner,
2026-11-14): `commands` and the rule against naming a shell or interpreter
don't apply to them.

**Owner asked before credentialed programs (v2.7, H-0201).** Until Beta,
before any role runs a command that names a program on the ask list, the
engine asks the owner. The engine's tool gate holds the command and files a
Security inbox item naming the role, the feature, the full command and the
working folder. The owner's approval lets that one command run once. A
refusal, or no answer within 30 minutes, denies it and tells the agent why.
The wait doesn't count toward the session's wall-time cap. The ask list is
`gh`, `aws`, `az`, `gcloud`, `gsutil`, `bq`, `railway`, `vercel`,
`netlify`, `fly`, `flyctl`, `heroku`, `doppler`, `op`, `vault`, `kubectl`,
`helm`, `terraform`, `pulumi`, `docker` and `ssh`. A project adds programs
under `policy.ask` in its manifest but can't remove listed ones. The gate
matches every word of the command, with any folder path and `.exe`, `.cmd`
or `.bat` stripped and case ignored. A command it can't split into words
counts as a match. Every match, and what came of it, is recorded in the
session's transcript and the run report; a denied step is reported as not
done. This catches commands the agent itself runs. The engine's own build
and test commands are not agent tool calls and are not covered. It doesn't
catch a program started by code the agent runs, such as a test or a
package script, or code that reads a login file directly. Those stay under
ADR 0026's accepted risks.

**Container per agent session (H-0045 and H-0052, owner, 2026-11-10;
wording approved by decision card; suspended until Beta by v2.7).** The engine runs every agent
session, the agent process included, in its own container, so the agent's
tools, hooks and everything they start stay inside it. Agents would
otherwise run as the owner's OS user (ADR 0014), so the container is what
keeps the owner's machine out of reach:
- **Mounts:** only the session's worktree (read-only for a role with no
  `write` allow outside `.factory/`) and per-project cache volumes for
  build tools. Never the owner's home folder, the engine's socket or
  `.factory/engine.json`, the container runtime's socket, or any other
  host path.
- **No owner credentials:** none are copied, mounted or passed in. The
  only secret inside is the session's model token; a role that needs
  GitHub gets the factory's machine-account token, never the owner's.
- **Image:** built per project from a base image pinned by digest plus the
  project's approved toolchain (S4.1); the agent runs as a non-root user,
  with a read-only root filesystem apart from the worktree, the cache
  volumes and a temp folder, all capabilities dropped, no new privileges,
  and CPU, memory and process limits.
- **Network:** the container reaches only the model API and the role's
  `network` hosts, through an egress proxy the engine runs; nothing else.
- **Write rules:** inside the worktree the container can't tell one path
  from another, so when a session ends the engine compares its branch with
  where it started. A changed path that the role's `write` rules don't
  allow (deny wins) rejects the whole session's changes and files a
  Security alert. A fresh worktree holds only tracked files, so untracked
  secret files never reach a container; committed ones are reported by
  the onboarding assessment.
- **Fail closed:** if the container runtime is missing or a container
  can't start with these settings, no agent session starts. On Windows
  this needs Docker Desktop with the WSL2 back end.
`commands` may not name a shell,
interpreter or command wrapper. That is a guard rail; the container is the
boundary. Build and test tools run repo code by design, so arguments are
not restricted. A repo override may not add tools.
`network.allow` lists host names. From v2.2 the single entry `"*"` means any
host, and is allowed only for a role whose tools are only `fetch_page`,
`WebFetch` and `WebSearch`, so open web content never reaches an agent that can see
project files (F-005 SR-17).

**Web reader (v2.2, optional role).** Fetches and summarizes web pages for
another agent. From v2.5 it fetches only through the engine tool
`fetch_page { url }`, which returns `{ url, text, truncated }`: fetched
through the egress proxy under its address rules, size capped, as plain
text with the address it came from. Claude Code's `WebFetch` processes a
page inside the agent, where the engine can't strip it, so the reader
doesn't have it. The engine strips hidden content (HTML comments, script and
style, hidden elements, zero-width and bidi characters, metadata) before the
reader sees a page; the reader returns plain text with the source address,
which the caller treats as untrusted data. The engine logs every address and
search. Its policy is fixed:

```yaml
    web-reader:
      tools:
        allow: ["fetch_page", "WebSearch"]
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

**Project evaluator and context hygiene (v2.3, optional roles).** Both are
advisory: they read the project and write only their own agent report. Items
they propose (the evaluator's Product decision, the hygiene agent's
Configuration hygiene items) go in that report and are filed by the
orchestrator from the report's `proposed_items`. The evaluator must also
deny reading `calibration/**`, `**/calibration/**`, `.factory/tuning/**`,
`**/.factory/tuning/**`, `.factory/runs/**/review.json` and
`**/.factory/runs/**/review.json`: calibration answers, tuning metrics and run
reviews (which record whether its predictions were right) all score it
(F-002 SR-1, SR-8). Neither role gets `Edit`, `Bash`, `Skill`, commands or network. The
prompts and skill-use records the hygiene agent reviews are outside Git, so
the engine hands them over; they add no read globs.

```yaml
    project-evaluator:
      tools:
        allow: ["Read", "Grep", "Glob", "Write"]
      read:
        allow: ["**"]
        deny: [<the secret files above>, "calibration/**", "**/calibration/**", ".factory/tuning/**", "**/.factory/tuning/**", ".factory/runs/**/review.json", "**/.factory/runs/**/review.json"]
      write:
        allow: [".factory/runs/**/project-evaluator-*.json"]
      commands:
        allow: []
      network:
        allow: []
    context-hygiene:
      tools:
        allow: ["Read", "Grep", "Glob", "Write"]
      read:
        allow: ["**"]
        deny: [<the secret files above>]
      write:
        allow: [".factory/runs/**/context-hygiene-*.json"]
      commands:
        allow: []
      network:
        allow: []
```

The requirements analyst gets `Skill` and reaches the web only through the
web reader; its own `network` stays empty. Reading other features' specs and
interview transcripts, and escalating to the advisor (F-006, once built), go
through the engine, not through new read globs.

**Advisor (v2.4, optional role).** Researches one hard question, after the
owner approves the call, and returns advice for the owner (F-006). It reads
what the requirements analyst may read, uses the shared skills, and reaches
the web only by asking the web reader through the engine (F-006 SR-1); its
own `network` stays empty. It has no writes and no shell: a shell needs its
own Security decision once the R2-1 sandbox exists (F-006 SR-9). Its policy
is fixed, and the checker refuses anything wider:

```yaml
    advisor:
      may_request: ["requirements-analyst", "orchestrator"]
      tools:
        allow: ["Read", "Grep", "Glob", "Skill"]
      read:
        allow: [<the requirements analyst's read allow list>]
        deny: [<the requirements analyst's read deny list>, <the advisor's extra denies>]
      write:
        allow: []
      commands:
        allow: []
      network:
        allow: []
```

Its tools are a subset of `Read`, `Grep`, `Glob` and `Skill`. Each glob in
its `read.allow` must be one of the analyst's, or sit under an analyst glob
`**` or `<path>/**`; the checker refuses any it can't show is inside. Its
`read.deny` includes the analyst's and the advisor's extra denies: `.factory/**`, `**/.factory/**`.
These hold in the project policy and in each repo's effective policy.
`write.allow`, `commands.allow` and `network.allow` are empty or missing.
The advisor reads nothing on `factory/state` (amendment H-0076): no inbox
item, transcript, earlier advice (`.factory/advice/`), run record or tuning
data, since stored advice quotes other features' questions and answers and
would let planted text return as "past research". Of the interview
transcripts, it sees only the current feature's, which the engine supplies
in its input (F-006 FR-6, A-3). File pointers the caller gives the advisor
must match its read rules; the engine drops any other pointer from the
input and reports it to the owner.

**Requests (v2.4).** A role may carry `may_request`: the roles that may ask
the engine to start it. A missing key means no role may. The engine takes
the requesting role from the session it started, never from a field in a
request or a file (F-006 SR-3), and refuses requests from any role not
listed. Only `advisor` may have the key, and it may list only
`requirements-analyst` and `orchestrator`; on any other role it is refused.
`may_request` is set in the project policy only, never in a repo override.
A request is not an approval: an advisor call still needs the owner's
(F-006 FR-3).

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

## Project manifest — v1.7

- Status: Approved (v1.1); v1.2 draft, awaiting owner approval (H-0014);
  v1.3 approved (H-0080); v1.4 approved (H-0087); v1.5 approved (H-0135);
  v1.6 approved (F-013 OQ-11, owner, decision card, 2026-11-13); v1.7
  approved (F-015 H-0193, owner, decision card, 2026-11-14)
- Owner decision: ADR 0010; requirements from the owner (2026-11-09); v1.1
  adds `policy` and `repos[].policy` (owner, 2026-11-10, H-0008); v1.2 adds
  `complexity` and `settings.agents` (F-002 A-6, A-8); v1.3 adds `enabled`,
  `owner` and `allowed_repo_owners` (ADR 0012, F-007 OQ-2; owner, decision
  card, 2026-11-11); v1.4 adds `limits` (F-007 SR-18, H-0087; owner,
  decision card, 2026-11-11); v1.5 adds `settings.endpoints` (F-013 SR-8,
  H-0135; owner, decision card, 2026-11-13)
- Used by: engine (resolves effective config), owner (edits it), VS Code extension (later)
- Compatibility: adding an optional key is non-breaking; renaming or removing one is breaking.

**Location:** `factory-project.yaml` at the root of the project's config repo.
Full format, validation rules, and an example are in
`proposals/0013-project-manifest.md`. Required top-level keys: `schema`
(`factory-project/1.0`), `name`, `factory.version`, `repos`, `maturity`.
Optional: `description`, `skills`, `agents`, `standards`, `settings`, `notes`,
`policy` (Role policy v2.0). Each entry of `repos` may carry `policy`
overrides. From v1.2, optional `complexity` (`simple`, `moderate`, `complex`:
the preset used only for initial calibration) and
`settings.agents.<role>.rung` (the role's approved rung of the master
ladder; the engine refuses a rung that doesn't exist in the pinned factory
version or is below the role's floor). Both change only through hygiene
items (F-002). The manifest is the only record of repo and project maturity
levels. `schema` stays `factory-project/1.0`: v1.1 to v1.7 only add optional keys.

From v1.5, optional `settings.endpoints`: a list of model endpoint names
(Model endpoints file v1.0) this project's code may be sent to; default
empty, so a project uses no endpoint until it lists one (F-013 SR-8). Names
match `^[a-z0-9-]{1,32}$` and are unique. A name the PC's endpoints file
doesn't define makes that endpoint's rungs unavailable for the project, not
an error.

From v1.6, `settings.agents.<role>` may also hold the role's endpoint
assignment (F-013 OQ-11): `model` (`<endpoint>/<model>`) with `fallback` (a
Claude model id, required with an endpoint `model`), or, for the security
reviewer and validation judge only, `advisory` (`<endpoint>/<model>`, an
advisory first pass while the role itself stays on Claude). The endpoint
must be in `settings.endpoints`, and an endpoint `model` is refused for a
role whose policy isn't read-only (F-013 SR-9). It changes only through a
hygiene item. Example:

```yaml
settings:
  endpoints: [lan]
  agents:
    web-reader: { model: lan/qwen3.8-27b, fallback: claude-haiku-5-5 }
    security-reviewer: { advisory: lan/qwen3.8-27b }
```

From v1.7 (F-015 H-0193), optional `repos[].commands` and
`owner.commit_name`:

```yaml
owner:
  commit_name: <name>            # overrides the GitHub profile name on the engine's code repo commits (F-015 FR-17)
repos:
  - name: web
    commands:
      test: ["npm", "test", "--", "--reporter=junit", "--outputFile=reports/junit.xml"]
      test_results: reports/junit.xml
      build: ["npm", "run", "build"]
```

`test` and `build` are non-empty lists of strings, run as an argument list
with no shell. `test_results` is the JUnit XML file `test` writes, a relative
path that must resolve inside the worktree under the ADR 0015 path rule. A
repo without `commands.test` can't enter stage 5 (F-015). `commit_name` is a
non-empty string of at most 100 characters with no control characters.
Onboarding (F-003) asks for the commands per repo.

From v1.4, optional `limits`: the same keys as the master factory's
`engine/config/limits.yaml` (H-0087). For each key the engine uses the lower
of the project's value and the master default. A project value above the
default is refused, and the engine files a Security item.

**Owner and authorization keys (v1.3).** The owner's own values live here,
in the project's config repo, never in the master factory repo, which ships
placeholders only (owner, 2026-11-11):

```yaml
enabled: false                 # ADR 0012; onboarding writes false
owner:
  github_id: <numeric id>      # the only account whose device approval opens an interview (ADR 0014)
  oauth_client_id: <client id> # the owner's OAuth app, device flow, no scopes, no secret
allowed_repo_owners:           # accounts whose repos this project may work on (ADR 0012)
  - { login: <login>, id: <numeric id> }   # the engine checks the id; the login is for people
```

The keys are optional for validation, but the engine refuses to run a
project that lacks `enabled` or `owner`. `enabled` is a boolean;
`github_id` and each `id` are positive integers; `oauth_client_id` is a
non-empty string. Every `repos[].url` must be owned by an
`allowed_repo_owners` id, checked against GitHub's answer for the repo,
not the URL text. The engine reads the manifest from the config repo's
`main` commit and pins `owner.*`, `allowed_repo_owners` and `enabled`;
a change to them needs the owner's confirmation and a device approval by
the previously pinned owner (F-007 SR-5).

**Protected defaults:** `security-review` and the six core agents (orchestrator,
requirements-analyst, software-developer, test-engineer, security-reviewer,
validation-judge) may never be excluded; overriding one requires a linked,
approved Security decision and may only add rules. The two support roles,
`project-evaluator` and `context-hygiene`, are not protected: a project may
exclude either with a reason (owner, 2026-11-10).

---

## Model endpoints file — v1.0

- Status: Approved (H-0135, owner, decision card, 2026-11-13)
- Owner decision: F-013 (configurable model endpoints), ADR 0019
- Used by: engine (reads it, generates the LiteLLM configuration, pins
  addresses), owner (edits it)
- Compatibility: adding an optional key is non-breaking; renaming or
  removing one, or tightening a rule, is breaking.

**Location:** `factory-endpoints.local.yaml` in the owner's clone of the
master factory repo, next to `factory-projects.local.yaml`. Git-ignored and
never committed (CI fails if it is tracked). The engine refuses it unless
only the owner can write it, as for the paths file (H-0081). A missing file
means no endpoints.

```yaml
endpoints:
  lan:                               # name: ^[a-z0-9-]{1,32}$, not "anthropic"
    base_url: http://<host>:8080     # absolute http(s) URL, no userinfo, query or fragment
    model: qwen3.8-27b               # the model id the endpoint serves
    api: anthropic                   # anthropic | openai
    api_key_ref: lan                 # optional; key read from the OS credential store as endpoint-key/<ref>
    max_sessions: 1                  # 1..16, default 1
    billing: local                   # local | per_token | subscription
    deadline: { margin_s: 60 }       # optional, 10..3600, default 60
    allow_loopback: false            # default false
  hosted:
    base_url: https://<provider host>
    model: <model id>
    api: openai
    api_key_ref: hosted
    billing: per_token
    prices: { input_per_mtok: 0.5, output_per_mtok: 1.5 }   # per_token only
  plan:
    base_url: https://<provider host>
    model: <model id>
    api: anthropic
    api_key_ref: plan
    billing: subscription
    plan:                            # subscription only
      limits:
        - { kind: requests, count: 200, window: 5h }   # requests | input_tokens | output_tokens; 5h | day | week | month
      reserve_pct: 10                # 0..90, default 10
```

Unknown keys are refused. The engine resolves each `base_url` host on the
PC and classes the endpoint private or public by its addresses (F-013
FR-4): a public endpoint needs `https` and `api_key_ref` (SR-12), `local`
billing needs a private endpoint (SR-15), and a name resolving to both
classes is refused. Keys and addresses never appear in logs, reports or an
agent's environment (SR-2).

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

## Tuning metrics — v1.1

- Status: Approved (v1.0); v1.1 draft, awaiting owner approval (H-0015)
- Owner decision: F-002 A-1, A-8; v1.1 adds the cost unit (owner, 2026-11-10, decision card)
- Used by: engine (writes; orders the ladder), orchestrator and owner (read)
- Compatibility: as for inbox items.

**Location:** `.factory/tuning/metrics.json` on the project config repo's
`factory/state` branch. Only the engine writes it.

```json
{
  "schema": "tuning-metrics/1.0",
  "updated_at": "2026-11-10T00:00:00Z",
  "cost_unit": "usd | plan_usage",
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

From v1.1, `cost_unit` follows the project's budget mode (ADR 0012):
`usd` in `tokens` mode, `plan_usage` (share of the plan's usage window) in
`subscription` mode. `cost_usd` fields then hold that unit; the ladder
order always uses it. Token counts are kept either way.

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

---

## Interview tools — v1.1

- Status: Approved
- Owner decision: F-007 OQ-8, H-0082, tightened by Security Gate 1 #10;
  owner, decision card, 2026-11-11; v1.1 (F-009, H-0106) approved by the
  owner, 2026-11-12 (decision card, as drafted); spec lines shown and
  locked, source checks tightened (F-009 Gate 2 M3), owner, 2026-11-12
  (decision card); `source_unchanged` check stated (H-0109), owner, 2026-11-12
  (decision card)
- Used by: engine (serves them), requirements analyst (calls them)
- Compatibility: adding a tool or an optional parameter is non-breaking;
  changing a parameter, a result or a limit is breaking.

The engine gives the requirements analyst these tools in its session,
through an in-process MCP server named `factory`. They are the analyst's
only way to reach the owner. Text fields are stored and shown as written,
and are data to the engine.

| Tool | Params | Result |
|---|---|---|
| `interview_ask` | `{ text, why, suggested?, options?: [string], findings?: [{ text, source }] }` | `{ item }`; a new question, status `open` |
| `interview_propose_assumption` | `{ text, why }` | `{ item }`; `open` until the owner approves or rejects it |
| `interview_revise` | `{ item, text, why, suggested?, options?, findings? }` | `{ revision }`; answers a `more_info` reply: a new revision, back to `open` |
| `research_web` | `{ query }` | `{ summary, sources: [string] }` from the web reader, labelled untrusted |
| `interview_spec_ready` | `{ spec_path, spec_version }` | `{ checks: [{ name, passed, evidence }] }` |

Rules:
- The server is built per session with its project and feature fixed. No
  tool takes a feature; `item` must belong to the session's feature, and
  ids match the channel's id pattern.
- One question at a time: `interview_ask` is refused with `one_at_a_time`
  while an earlier question is `open` and not deferred. Assumptions don't
  count against this.
- Limits: `text` up to 4,000 characters, `why` up to 2,000, up to 8
  `options` of up to 200, up to 20 `findings` with `text` up to 2,000 and
  `source` an `https` URL up to 2,000; `query` one line up to 400;
  `spec_version` a non-negative integer; unknown keys refused. Over a limit
  is `invalid`.
- Caps: at most 5 open assumptions, 200 items per feature, and a
  per-question and per-session cap on `research_web`; over a cap is
  `limit`, and the owner is told.
- `spec_path` must be the session's own `docs/features/F-nnn-*.md`, resolved
  by the Role policy path rule.
- The analyst's turn ends after it asks. Each owner reply reaches it as the
  next turn's message, wrapped by the engine between two lines carrying a
  random per-turn boundary, with the item, revision, reply kind and the
  text's length, and the owner's text unchanged between them. Nothing else
  in a turn's message comes from the owner.
- `research_web` sends only the query; the engine logs it against the item.
- Errors: `one_at_a_time`, `invalid`, `limit`, `unknown_item`,
  `wrong_status` (for example revising an item that had no `more_info`
  reply).

**v1.1 (F-009, H-0106).** For a feature started from a document:
- `interview_ask` and `interview_revise` take an optional `type`: `gap`,
  `conflict` or `ambiguity`. A `conflict` question quotes both sides in
  `findings`, with `source` either an `https` URL or a worktree path.
- The spec carries a `## Sources` table with columns `Spec ref` (an FR,
  AC, SR or section id in the spec), `Section` (the document's heading)
  and `Quote` (up to 1,000 characters). Required when `provenance` is
  `owner`; allowed when it is `reference`.
- New tool `interview_confirm_sources { spec_path, spec_version }` →
  `{ item }`. The engine reads the table and checks every row against the
  stored document (whose hash must still match the transcript) and the
  spec: the spec has a line for `Spec ref` (outside the Sources table: a
  table row whose first cell is the ref, a line that opens with it, or a
  heading that starts with it); `Section` is one of the document's
  headings, or `-` when it has none; the quote is at least 5 words or 25
  characters, and sits in one paragraph, list item or table row under that
  heading, matching after runs of whitespace are collapsed. It refuses with
  `invalid`, naming the failing rows, if any row fails. Otherwise it builds
  the `source_confirmation` item from the table itself, with each spec
  ref's own line. A later spec version that changes the table, or any of
  those spec lines, needs a new confirmation.
- `interview_spec_ready` adds the check `source_unchanged` whenever the
  feature started from a document: the branch's copy of the document still
  matches the SHA-256 recorded at the start (F-009 Gate 2 L1).
- `interview_spec_ready` adds the check `sources_confirmed` when
  `provenance` is `owner`: the latest `source_confirmation` item is
  confirmed and its table and spec lines match the spec's current ones.
- `spec_path` may not be a `*-source.*` file.
