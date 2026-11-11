# Feature: Run spec interviews on the real engine

- **Id:** F-007
- **Status:** Approved (readiness gate passed 2026-11-11)
- **Requested by / date:** Alex, 2026-11-11
- **Spec version:** 32

This is the first increment of the factory engine (ADR 0001). The engine as a
whole is too large for one feature, so it is built in increments, each a
feature of its own with its own gates. The owner chose this increment first
(OQ-1, decision card, 2026-11-11); the order of the rest is in section 13.

## 1. Objective and business purpose
The interview skill (F-005) and the advisor client (F-006) are built and
tested, but only against a fake engine. Nothing yet runs the requirements
analyst, so the owner can't hold a real interview, and every later stage
depends on a real spec coming out of one.

This increment builds the engine far enough for the owner to request a
feature, approve the session on their phone, and be interviewed by the real
requirements analyst, running in its own container, until the spec passes the
interview checks of the readiness gate. It also lays the parts every later
increment reuses: the engine process, the control channel, the `factory/state`
worktree, the master config, agent sessions in containers, and the egress
proxy.

## 2. Expected behavior
1. The owner starts the engine (a command for now; the VS Code extension
   starts it in a later increment). It reads the master config and the
   enabled projects' manifests, checks its credentials against each project's
   billing mode, checks out `factory/state` at `.factory/` where missing,
   opens the control channel and writes `.factory/engine.json`.
2. In Claude Code the owner runs `/software-factory:spec-interview` and
   requests a feature, or picks one waiting for an interview. Nothing changes
   in the skill.
3. The engine starts GitHub's device sign-in. The owner enters the code on
   their phone. The engine accepts the session only for the recorded owner.
4. The engine starts the requirements analyst as an Agent SDK session in its
   own container. The analyst asks questions and proposes assumptions through
   tools the engine provides; the engine turns them into interview items. The
   owner's replies go back to the analyst word for word.
5. "More information" runs the analyst's research (and the web reader, inside
   its own container) and the question comes back with findings and sources.
6. The engine writes the transcript under `.factory/interviews/<feature>/`
   and the spec under `docs/features/` on the feature branch, committing after
   each edit (ADR 0012), with the secrets scan before each commit.
7. When the analyst says the spec is ready, the engine runs the interview
   checks of the readiness gate (F-005 FR-8, FR-9, SR-11) and reports the
   result through `engine.status` and the agent report. Stages 3 and 4 in full
   come in a later increment.
8. `engine.status`, `engine.pause`, `engine.resume` and `engine.shutdown`
   work as the channel contract says.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | The engine is a TypeScript Node process in `engine/` (ADR 0001, 0003), started by a command. One engine serves all enabled projects on the machine. |
| FR-2 | At start it loads each enabled project's manifest from its config repo, which holds the owner's GitHub id, the OAuth client id and the allow list (OQ-2, H-0080). The engine finds the config repos from a git-ignored file in the user's clone of the master repo that lists their paths and holds no settings (owner, 2026-11-11; the `.gitignore` entry is hygiene item H-0081). It refuses to run a project whose manifest fails validation, whose repo isn't reachable with the factory token, or whose owner isn't on the allow list (ADR 0012). A refusal files a Security item and stops only that project. |
| FR-3 | It refuses to start when its model credentials don't match a project's billing mode (ADR 0012). |
| FR-4 | It serves Engine control channel v1.3 on a Unix socket or Windows named pipe with every access rule of the contract, and writes `engine.json` as the contract says. Advisor reply kinds return `kind_not_allowed` until the advisor increment, and `engine.json` and `engine.status` report channel version `1.2` until the advisor increment, so the skill doesn't offer the advisor (F-006 FR-11; owner, decision card, 2026-11-11). |
| FR-5 | `feature.start` assigns the next feature id, creates `feature/F-nnn-name` from `main` (ADR 0005) and queues the interview. New features enter only this way (ADR 0012). |
| FR-6 | `interview.*` follow channel v1.3 and the interview rules: session lock by token, takeover, revisions, reply ids, deferred items once per session, `wait_s`, error codes. |
| FR-7 | Every interview session needs the owner's GitHub device approval before any reply is accepted, exactly as ADR 0014 sets out: no scopes, no client secret, owner id check, token discarded, fail closed, 30-minute idle and 2-hour limits, every GitHub field validated (SR-23). |
| FR-8 | The analyst and the web reader run as Agent SDK sessions, each in its own container as the Role policy contract sets out (ADR 0015): worktree and caches only, pinned image, non-root, read-only root, no capabilities, no owner credentials, no engine socket, egress only through the sidecar proxy (SR-6 to SR-9) to the model API and the role's hosts. No container, no session. |
| FR-9 | Each role gets exactly its policy's tools; the engine checks every file tool call against the role's `read` and `write` rules with the ADR 0015 path rule, and when the session ends compares the branch with the write rules and rejects the session's commits on a breach. |
| FR-10 | The analyst reaches the owner only through engine tools (OQ-8): ask a question, propose an assumption, request research, report the spec ready. The engine never answers for the owner and never turns analyst text into a reply. |
| FR-11 | After each agent edit the engine commits the worktree change to the agent's branch (ADR 0012). The engine alone writes the transcript, append-only, on `factory/state`, and runs the secrets scan before each commit, blocking it on a hit. |
| FR-12 | When the analyst reports the spec ready, the engine runs readiness checks 5 and 6 for interviews: no question `open` or `deferred`, no pending assumption, and every assumption the spec marks approved matches an `approve_assumption` transcript entry. |
| FR-13 | Each agent run writes an Agent report v1.1 under `.factory/runs/` on `factory/state`, with the engine-filled fields (model, effort, usage, transcript reference). |
| FR-14 | An interrupted run is marked `interrupted`, uses no retry, and resumes from its session or from the last commit with a transcript summary (ADR 0012). |

## 4. Acceptance criteria
Drafted from the requirements above; each is refined in the interview.

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a valid master config and one enabled project, when the engine starts, then `engine.json` exists with mode 0600 and the served channel version, and `engine.status` answers. | FR-1, FR-4 |
| AC-2 | Given a project whose repo owner isn't on the allow list, when the engine starts, then that project doesn't run, a Security item is filed, and other projects run. | FR-2 |
| AC-3 | Given an `ANTHROPIC_API_KEY` in the environment and a project in subscription mode, when the engine starts, then it refuses with a clear message. | FR-3 |
| AC-4 | Given a peer that isn't the owner, or a process the engine started, when it connects, then it is refused. | FR-4 |
| AC-5 | Given `feature.start`, then a feature id and branch exist and `interview.list` shows the feature. | FR-5 |
| AC-6 | Given an open session not yet approved, when the client calls `interview.next`, then it gets `approval_pending`; given approval by a GitHub account other than the owner, then `approval_failed`. | FR-7 |
| AC-7 | Given an approved session, when the analyst asks a question through its tool, then `interview.next` returns it word for word, and the owner's answer reaches the analyst word for word. | FR-6, FR-10 |
| AC-8 | Given the analyst's container, then it can't read the owner's home, the engine socket or `engine.json`, can't reach a host outside its policy, and runs as non-root with a read-only root. | FR-8 |
| AC-9 | Given a session that writes outside its write rules, when it ends, then its commits are rejected and a Security item is filed. | FR-9 |
| AC-10 | Given a spec reported ready with a question still `deferred`, then readiness check 6 fails; with an approved assumption that has no `approve_assumption` entry, check 5 fails. (These are F-005 AC-7 and AC-8, carried here.) | FR-12 |
| AC-11 | Given a secret in a transcript entry, then the commit is blocked and nothing is pushed. | FR-11 |
| AC-12 | Given the engine killed mid-session, when it restarts, then the run is `interrupted`, resumes, and no retry is counted. | FR-14 |
| AC-13 | Given the Docker runtime is stopped, when a session would start, then no session starts and the owner is told why. | FR-8 |
| AC-14 | Given an agent container, when it connects straight to an outside address or to `host.docker.internal`, then the connection fails; with no proxy credential the proxy refuses it. | SR-6, SR-7 |
| AC-15 | Given the web reader asked for a private IP, `localhost`, or a name resolving to `127.0.0.1`, then the proxy refuses it. | SR-8 |
| AC-16 | Given a running analyst session, then the model credential appears nowhere in its container's environment or files. | SR-9 |
| AC-17 | Given a repo with `.claude/settings.json` hooks and a `CLAUDE.md`, when a session runs, then neither is loaded. | SR-10 |
| AC-18 | Given a `.husky/pre-commit` written in the container, when the engine commits, then it doesn't run. | SR-11 |
| AC-19 | Given a spec path that is a symlink to a file outside the worktree, then the engine refuses it and reveals nothing of the target. | SR-12 |
| AC-20 | Given a change to the pinned owner id in the manifest, then the project stops until the owner confirms and the previous owner approves on the phone. | SR-5 |
| AC-21 | Given a page with hidden text and zero-width characters, when the reader fetches it, then neither reaches the reader. | SR-21 |

## 5. Constraints
- TypeScript on Node (ADR 0001). Windows, macOS and Linux; Windows needs
  Docker Desktop with the WSL2 back end (ADR 0015).
- Every new library, tool and image gets a security review and an
  Architecture decision before use (S4.1), is pinned (S4.3) and checked for
  CVEs in CI (S4.4).
- Pins from the S4.1 reviews (Gate 1): koffi 3.3.6, the Claude Agent SDK
  0.3.311 with the Claude Code 2.1.311 its manifest names (upgraded only
  together), and `node:26.13.0-trixie-slim` by digest. A lockfile with
  integrity hashes; `npm ci --ignore-scripts` on the host; Claude Code's
  `postinstall` only in the image build, with the binary's SHA-256 checked
  against the SDK manifest. Each bump is a new S4.1 check (G1 #22).
- gitleaks 8.30.1, pinned by SHA-256 per platform (Gate 1 component review
  5). The engine never runs its git mode: it copies each blob with
  `git cat-file` into an engine-owned 0700 folder, files named by blob SHA,
  and runs `gitleaks dir` with the fixed flags in that review, report to
  stdout, redacted; any exit code but the two expected fails closed.
- The engine's own repo maturity is Rapid prototype until promoted, so the
  bar in `maturity-levels.md` applies.
- No change to the skill or the channel contract is needed for this
  increment, except as OQ-8 and OQ-2 decide.
- Change-controlled files (contracts, agent files, CI) change only through
  hygiene items H-0080 to H-0089, in their own PRs.

## 6. Edge cases
- Two clients open the same feature; a takeover during a pending approval.
- The owner approves on the phone after the device code expired.
- GitHub unreachable during approval (fail closed, no fallback).
- The analyst asks the same question twice, or asks while research runs.
- The container dies mid-turn; the engine restarts while a session is open.
- A feature started while its project is paused or disabled.
- `factory/state` has commits the engine didn't make (another machine, the
  extension).
- Disk full while committing the transcript.

## 7. Dependencies
- F-005 skill and client; F-006 client (advisor kinds stay refused here).
- ADRs 0001, 0003, 0004, 0005, 0009, 0010, 0012, 0014, 0015.
- Contracts: Engine control channel v1.3, Role policy v2.4, Project manifest
  v1.1 (v1.2 and `enabled` are drafts), Agent report v1.1, Inbox item v1.1.
- The owner registers the GitHub OAuth app with device flow (ADR 0014).
- Docker Desktop on the owner's machine.
- External components, each pending its S4.1 review: the Claude Agent SDK
  and Claude Code inside the image, a base image, and whatever OQ-3 and OQ-5
  choose.

## 8. Assumptions
None yet. Any the analyst proposes are approved or rejected by the owner in
the interview, never recorded otherwise.

| Id | Assumption | Decision link | Status |
|---|---|---|---|

## 9. Security considerations
From the analyst and Security Gate 1 (`F-007-security-gate1.md`, finding
numbers in brackets). At Rapid prototype none blocks; the High ones (G1 #1
to #7) block at Alpha, so they are requirements now.

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | The model credential, the factory token, the device-flow token and `device_code`, interview session tokens and proxy credentials never reach a log, a file in Git, an inbox item, an argument list or an agent's prompt. | Analyst; G1 comment on SR-1 | Draft |
| SR-2 | Fail closed on every check: config, authorization, approval, container start and its post-start inspection (SR-14), proxy start and address rules (SR-8), secrets scan. | Analyst; G1 comment on SR-2 | Draft |
| SR-3 | Analyst tool calls and owner text are data to the engine. Tool arguments are validated against the Interview tools limits before use; the engine never executes or interprets them. | Analyst; G1 comment on SR-3 | Draft |
| SR-4 | Each external action (GitHub calls, pushes) is logged with agent, action, target, time and approval id, without secrets. | Analyst (S9.6) | Draft |
| SR-5 | The engine reads each manifest from its config repo's `main` commit, never the working tree. It pins `owner.*`, `allowed_repo_owners` and `enabled` when the owner first approves them, in an engine-only record outside every repo. Any change to them, or a new path in the project list, stops that project and files a Security item; it runs again only after the owner confirms at an engine command and approves a device sign-in as the previously pinned owner id. Increment 3 replaces this with the signature check. | Analyst; G1 #7, #9; owner decision 2026-11-11 | Approved |
| SR-6 | Agent containers join only an `--internal` Docker network with no route out. The proxy runs as a sidecar container from the pinned base image and is the only member with a second, outside network. A direct connection from an agent container to an outside address or to `host.docker.internal` fails. | G1 #1; owner decision 2026-11-11 | Approved |
| SR-7 | Each container gets its own random proxy credential bound to one session and role. The proxy applies that role's allow list, refuses a missing or unknown credential, drops it when the session ends, and listens only on the internal network. | G1 #2 | Draft |
| SR-8 | The proxy resolves each host itself and refuses loopback, private, CGNAT, link-local, unique-local, multicast, unspecified and Docker network addresses (and IPv4-mapped forms), connecting only to the address it checked. It refuses IP literals for open-web roles. CONNECT to port 443 only. | G1 #3 | Draft |
| SR-9 | The model credential never enters an agent container. The container gets the proxy as its API base URL and a dummy key; the proxy adds the real credential, forwards only to `https://api.anthropic.com` on the API paths Claude Code uses, and drops any request carrying a credential of its own. If a subscription token can't pass a gateway, the owner is asked before any fallback. | G1 #4; owner decision 2026-11-11 | Approved |
| SR-10 | Fixed session options: `settingSources: []`; `strictMcpConfig: true` with only the engine's `factory` server; the tool list is exactly the role's tools plus its `factory` tools; skills only from the pinned master factory version, baked into the image; never a bypass permission mode; hooks only the engine's own callbacks; instructions from `agents/<role>/AGENT.md`, never the worktree. Every session uses the engine's container spawn; without it no session starts and no `claude` process starts on the host. Auto-update, telemetry, error reporting and non-essential traffic are off in the container. | G1 #5 | Draft |
| SR-11 | Every git command the engine runs has hooks off (empty engine-owned `core.hooksPath`, `--no-verify`), `core.fsmonitor=false`, no repo filters or textconv, `protocol.file.allow=never`, and no credential helper or SSH command. Pushes go over HTTPS with the factory token passed by `GIT_ASKPASS`, never in a URL or argument. Nothing from the worktree runs on the host. | G1 #6 | Draft |
| SR-12 | Every engine read of a worktree path uses the ADR 0015 real-path rule and refuses a path that leaves the worktree. `spec_path` must be the session's own `docs/features/F-nnn-*.md`. The end-of-session check rejects any new or changed symlink. The secrets scan reads blobs from git. | G1 #8 | Draft |
| SR-13 | The project paths file is refused if it is a symlink, isn't owned by the owner, or is group- or world-writable. A listed path is refused if it isn't absolute, is a symlink, isn't a Git work tree, or is the master repo or a clone of it. The master repo's CI fails if that file is ever tracked, or if templates or fixtures hold anything but placeholders. | G1 #9 | Draft |
| SR-14 | `docker` runs by absolute path with an argument array, no shell, a fixed local context, and `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and `DOCKER_TLS*` cleared. Container names come from validated ids only. After each start `docker inspect` must confirm image digest, user, read-only root, no capabilities, `no-new-privileges`, CPU, memory and pids limits, network and exact mounts, or the container is stopped. On Linux, rootless Docker or Docker Desktop is recommended, since the daemon is root-equivalent. | G1 #14 | Draft |
| SR-15 | Every FFI step fails closed. After creating the socket or pipe the engine reads its mode or ACL back and refuses to serve unless only the owner has access. FFI sits in one small module with a fixed list of OS functions. CI on all three OSes runs negative tests: another user's peer, a wider ACL, a forced FFI error. | G1 #13 | Draft |
| SR-16 | Feature ids are unique across all of the engine's projects, so a feature id alone names its project (OQ-10). Session state is per project: session tokens, device approval, containers, volumes, proxy credentials and image are never shared across projects. | G1 #11; owner decision 2026-11-11 | Approved |
| SR-17 | The engine keeps a hash chain over the transcript entries it writes, with the head in its own record. On fetch it refuses transcript changes that don't extend the chain, files a Security item and fails that feature's readiness checks. | G1 #12 | Draft |
| SR-18 | Each session has fixed caps on turns, output tokens or dollars, and wall time; each container on CPU, memory, pids and temp size; all in change-controlled config. A run at a cap stops and reports. At most 3 resumes per run, then `failed`. The billing-mode check runs before each session. | G1 #17 | Draft |
| SR-19 | CI scans the built image and the engine's lockfile on every change with OSV-Scanner (re-reviewed for image mode). The final agent image has no npm or npx. The engine's CI job has `contents: read` and no secrets. The secrets scanner is gitleaks, pinned by version and checksum, run by the engine on the host against git blobs (OQ-11). | G1 #18 | Draft |
| SR-20 | Secrets live in the OS credential store under a factory-specific name. Residual risk accepted: other programs running as the owner can read them; narrowed by a factory token scoped to the project's repos with an expiry and a spending limit on any API key. | G1 #19; owner decision 2026-11-11 | Accepted risk |
| SR-21 | The web reader fetches pages only through the engine's `fetch_page` tool, never Claude Code's `WebFetch`: through the proxy with SR-8's rules, hidden content stripped, size capped, plain text with its source address. `WebSearch` queries are logged from the SDK message stream. | G1 #20; owner decision 2026-11-11 | Approved |
| SR-22 | Transcript text is stored as data (JSON strings), never as live Markdown. The readiness check flags remote images and raw HTML in the spec. | G1 #21 | Draft |
| SR-23 | Every device-flow field from GitHub is validated: code formats, `verification_uri` exactly `https://github.com/login/device`, `expires_in` at most 900 s, `interval` and `slow_down` honoured. Default TLS checks. The owner is matched by numeric id, never login. | G1 #23 | Draft |

**Sensitive data (G1 #15).** The model credential, factory token, device
token and `device_code`, session tokens, proxy credentials, owner answers,
transcripts, Claude Code session files, engine and proxy logs, and local
paths. Session files live in a per-session volume, mounted only into that
session's resumed container and deleted when the run ends. Logs live in an
owner-only folder (0700, files 0600) outside every repo, hold no secrets or
reply text, and are kept for a fixed time. `factory/state` is pushed, so the
engine warns at start when a project's repo is public.

**External services (S9.1, G1 #16).** GitHub: device flow and `GET /user`
(read); `GET /repos/{owner}/{repo}` with the factory token (read); pushes of
`feature/*` and `factory/state` (act, ADRs 0005, 0006, 0009). Anthropic API
(act): role prompts, files the role reads, owner answers, web summaries. The
web (read), through the reader only. npm registry and Docker Hub only when
the image is built, never from a session. The factory token is fine-grained
to the project's repos, `contents: write` and `metadata: read`, with an
expiry, and never enters a container.

**Threat model (S9.7):** in the Gate 1 report.

## 10. Interface requirements
- Engine control channel v1.3: implemented as approved, plus amendment
  H-0084: error code -32008 `refused` for security refusals (owner,
  decision card, 2026-11-11; applied).
- The master repo ships only templates and placeholders; no owner's real
  values are ever committed to it (owner, 2026-11-11).

The four changes below were approved by the owner on 2026-11-11 (decision
card, as drafted after Gate 1) and applied in `docs/interface-contracts.md`,
the onboarding template and checker, `.gitignore` and the web reader's
AGENT.md.

### H-0080 (approved): Project manifest v1.3, owner and authorization keys
Adds optional keys; non-breaking. The engine refuses to run a project that
lacks `owner` or `enabled` (FR-2).

```yaml
enabled: false                 # ADR 0012; onboarding writes false
owner:
  github_id: <numeric id>      # the only account whose device approval opens an interview (ADR 0014)
  oauth_client_id: <client id> # the owner's OAuth app, device flow, no scopes, no secret
allowed_repo_owners:           # accounts whose repos this project may work on (ADR 0012)
  - { login: <login>, id: <numeric id> }   # the engine checks the id; the login is for people
```

`repos[].url` must be owned by an `allowed_repo_owners` id, checked against
GitHub's answer for the repo, not the URL text. The onboarding template gets
placeholders only.

### H-0081 (approved): `.gitignore` in the master repo
Add `/factory-projects.local.yaml`: the list of the user's config repo
clones, `projects: [{ path: <absolute path> }]`, with no settings. The engine
refuses a path that isn't a Git work tree with a valid manifest.

### H-0082 (approved): Interview tools v1.0 (OQ-8), a new contract
The engine gives the analyst these tools in its session (an in-process MCP
server named `factory`). They are the analyst's only way to reach the owner.
Every call is checked against the session's own feature; text fields are
stored and shown as written, and are data to the engine (SR-3).

| Tool | Params | Result |
|---|---|---|
| `interview_ask` | `{ text, why, suggested?, options?: [string], findings?: [{ text, source }] }` | `{ item }`; a new question, status `open` |
| `interview_propose_assumption` | `{ text, why }` | `{ item }`; status `open` until the owner approves or rejects it |
| `interview_revise` | `{ item, text, why, suggested?, options?, findings? }` | `{ revision }`; answers a `more_info` reply: the item gets a new revision and returns to `open` |
| `research_web` | `{ query }` | `{ summary, sources: [string] }` from the web reader in its own container, labelled untrusted |
| `interview_spec_ready` | `{ spec_path, spec_version }` | `{ checks: [{ name, passed, evidence }] }`; runs FR-12 |

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
- Caps: at most 5 open assumptions, 200 items per feature, and a per-question
  and per-session cap on `research_web`; over a cap is `limit`, and the
  owner is told.
- `spec_path` must be the session's own `docs/features/F-nnn-*.md` (SR-12).
- The analyst's turn ends after it asks. Each owner reply reaches it as the
  next turn's message, wrapped by the engine between two lines carrying a
  random per-turn boundary, with the item, revision, kind and the text's
  length, and the owner's text unchanged between them. Nothing else in a
  turn's message comes from the owner.
- `research_web` sends only the query; the engine logs it against the item.
- The advisor proposal tool comes with the advisor increment.
- Errors: `one_at_a_time`, `invalid`, `limit`, `unknown_item`,
  `wrong_status` (for example revising an item that had no `more_info`
  reply).

### H-0083 (approved): Role policy v2.5, web reader fetches through the engine
The web reader's `tools` lose `WebFetch` and gain the engine tool
`fetch_page { url }` → `{ url, text, truncated }`: fetched through the proxy
under SR-8, hidden content (comments, scripts, hidden elements, zero-width
and bidi characters) stripped, plain text capped in size, with the address
it came from. `WebSearch` stays. A Role policy change (Interfaces, Security;
G1 #20, owner decision 2026-11-11).


### H-0085 (approved): engine CI workflow

Approved by the owner 2026-11-11 (decision card, all three systems) and
applied.

A new `.github/workflows/engine.yml`, so the engine's checks run on every pull
request that touches `engine/`. It follows `extension.yml`: read-only token,
runs on pull requests, pushes to main and weekly (S4.4), `npm ci
--ignore-scripts`, then `npm audit --audit-level=high`, typecheck, build and
the unit and acceptance tests. It runs on Linux, macOS and Windows, because
the engine has platform code (named pipe ACL, peer checks, credential store).
No secrets. The image scan (SR-19) joins it in milestone 2.


### H-0087 (approved): session limits (SR-18, H-0082 caps)

Approved by the owner 2026-11-11 (decision card, values as proposed).

Owner decision 2026-11-11 (decision card): defaults ship in the master repo,
and a project manifest may only lower them. Two changes:

1. A new change-controlled file `engine/config/limits.yaml` with the values
   below. It holds no owner values.
2. Project manifest v1.4: an optional `limits:` block with the same keys.
   The engine takes the lower of the two for each key and refuses a project
   whose block sets any value above the default (Security item).

| Key | Analyst | Web reader | Proxy |
|---|---|---|---|
| Turns per session | 300 | 30 | — |
| Output tokens per session | 500,000 | 60,000 | — |
| Dollars per session (API key mode) | 15 | 1 | — |
| Wall time per session | 4 h | 10 min | — |
| CPUs | 2 | 1 | 0.5 |
| Memory | 2 GiB | 1 GiB | 256 MiB |
| Processes (pids) | 256 | 128 | 64 |
| Temp space | 512 MiB | 256 MiB | 16 MiB |

| Interview cap | Value |
|---|---|
| `research_web` per question | 3 |
| `research_web` per analyst session | 20 |
| `fetch_page` bytes downloaded per page | 2 MiB |
| `fetch_page` characters returned per page | 50,000 |
| Research summary length | 2,000 characters |
| Sources returned per research call | 8 |
| Worktree commit: files changed | 200 |
| Worktree commit: total size | 5 MiB |
| Worktree commit: largest file | 1 MiB |

A session at any cap stops and reports which cap (SR-18).

## 11. Readiness gate
Run by the orchestrator, 2026-11-11, on spec v21.

- [x] Clear objective: section 1.
- [x] Expected behavior defined: section 2, FR-1 to FR-14.
- [x] Acceptance criteria testable: AC-1 to AC-21, each pass or fail, each
  linked to an FR or SR.
- [x] Constraints documented: section 5, with the approved pins.
- [x] Assumptions explicit: none. The interview ran in the project thread,
  not through the engine, so there is no engine transcript; no assumption
  was proposed or recorded.
- [x] Blocking decisions resolved: OQ-1 to OQ-11 and Gate 1 #1, #4, #7,
  #19, #20 all decided by the owner; H-0080 to H-0083 approved and applied.
  None deferred.

## 12. Open questions for the owner
Asked one at a time in the interview. None is assumed.

| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Is this the right first increment? | Product | Decided: real interviews end to end (owner, decision card, 2026-11-11) |
| OQ-2 | Where does the owner's factory config live (owner GitHub id, OAuth client id, allow list)? | Architecture, Interfaces | Decided: per project, in the project's config repo manifest (ADR 0010); nothing owner-specific in the master repo (owner, thread, 2026-11-11). Contract change drafted as H-0080 (section 10). Project paths in a git-ignored file in the master repo clone (owner, thread, 2026-11-11; H-0081) |
| OQ-3 | Node can't read a socket peer's uid or pid, set a named pipe's ACL, or read a pipe client's SID, all of which the channel contract requires. How do we get them: a small FFI library, a native addon, or a separate helper program? | Architecture, Security | Decided: the koffi FFI library, subject to its S4.1 security review before it is approved for use (owner, decision card, 2026-11-11) |
| OQ-4 | Approve the Claude Agent SDK, and Claude Code inside the agent image, after their S4.1 review. | Architecture, Security | Decided: koffi 3.3.6, Agent SDK 0.3.311, Claude Code 2.1.311, `node:26.13.0-trixie-slim` by digest and gitleaks 8.30.1 approved with their review conditions (owner, decision card, 2026-11-11) |
| OQ-5 | How the engine drives containers: the `docker` command line (no new library) or a Docker API library. And the egress proxy: written in the engine with Node's own modules, or an existing proxy image. | Architecture, Security | Containers: decided, the `docker` command line, no Docker library (owner, decision card, 2026-11-11). Proxy: decided, our own small proxy on Node's built-in modules, allowing only listed hosts on port 443 and logging each connection (owner, decision card, 2026-11-11) |
| OQ-6 | Which base image, pinned by digest. | Architecture, Security | Decided: Docker's official Node LTS image on Debian slim, pinned by digest, with its S4.1 review and CVE scanning (owner, decision card, 2026-11-11) |
| OQ-7 | How the model credential reaches a container and where the engine keeps it (subscription token from `claude setup-token`, or an API key), and where the factory token is stored. | Security | Decided: the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service) through koffi; the owner enters each secret once with an engine command (owner, decision card, 2026-11-11) |
| OQ-8 | The analyst-to-engine tools: names, parameters and results. | Interfaces | Decided: H-0082 approved (owner, decision card, 2026-11-11) |
| OQ-9 | Test tools for the engine: Vitest, as the extension uses, or Node's built-in runner. | Architecture | Decided: Vitest, as the extension uses (owner, decision card, 2026-11-11); coverage by `@vitest/coverage-v8`, pinned to match Vitest, dev dependency only, subject to an S4.1 review (owner, decision card, 2026-11-11) |

| OQ-10 | One engine serves several projects, but the channel has no project field (G1 #11). Keep feature ids unique across all projects (no contract change), or add a `project` parameter to the channel? | Interfaces | Decided: feature ids unique across all of the engine's projects; no channel change (owner, decision card, 2026-11-11) |
| OQ-11 | Which secrets scanner the engine uses before each commit (G1 #18): an existing tool after its S4.1 review, or patterns of our own in the engine. | Architecture, Security | Decided: gitleaks, pinned by version and checksum, after its S4.1 review (owner, decision card, 2026-11-11) |

### Security Gate 1 decisions
From `F-007-security-gate1.md`. All five decided; every finding is now in
section 9.

| Finding | Question | Status |
|---|---|---|
| #1 | Where the egress proxy runs | Decided: a sidecar container from the pinned base image, the only member of the agents' internal Docker network with a route out (owner, decision card, 2026-11-11) |
| #4 | How the model credential reaches a session | Decided: a credential gateway in the proxy; agents get a dummy key; if a subscription token can't pass a gateway, the owner is asked before any fallback (owner, decision card, 2026-11-11) |
| #7 | Guarding owner-key changes before signed owner actions | Decided: manifest read from `main`; `owner.*`, `allowed_repo_owners` and `enabled` pinned; a change stops the project until the owner confirms it and approves a device sign-in as the previously pinned owner; replaced by signatures in increment 3 (owner, decision card, 2026-11-11) |
| #19 | Residual risk of the OS credential store | Decided: accepted as residual risk, narrowed by scoped, expiring tokens, a spending limit on any API key and a factory-only store name (owner, decision card, 2026-11-11) |
| #20 | Web reader page fetching | Decided: engine `fetch_page` tool replaces `WebFetch` (owner, decision card, 2026-11-11); drafted as H-0083 |

## 13. Increments (first one chosen by the owner, OQ-1; later order open)
1. **This feature:** engine core, channel, phone approval, analyst and web
   reader in containers, transcript, interview readiness checks.
2. **Advisor:** the engine half of F-006 (its dev report's deferred list).
3. **Requirements to ready:** Security Gate 1 runs, the engine reads the
   inbox, owner actions count only when SSH-signed (ADR 0015), with the F-001
   follow-up that signs them; full readiness gate.
4. **Build to PR:** stages 5 to 9, CI gate, PR through the factory token.
5. **Budgets and control:** ADR 0012 budgets, `project.*` methods, the
   Factory view.
6. **Merge conflicts:** ADR 0013.

## 14. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-11 | Draft from the specs, ADRs and the F-005 and F-006 deferred lists, before the owner interview | — |
| 2 | 2026-11-11 | OQ-1: first increment is real interviews end to end | Owner, 2026-11-11 (decision card) |
| 3 | 2026-11-11 | OQ-2: owner config goes per project in the config repo manifest; master repo holds templates only | Owner, 2026-11-11 (thread) |
| 4 | 2026-11-11 | OQ-2: the list of project paths is a git-ignored file in the master repo clone | Owner, 2026-11-11 (thread) |
| 5 | 2026-11-11 | OQ-3: OS checks through the koffi FFI library, pending its S4.1 review | Owner, 2026-11-11 (decision card) |
| 6 | 2026-11-11 | OQ-5: containers driven through the `docker` command line | Owner, 2026-11-11 (decision card) |
| 7 | 2026-11-11 | OQ-5: egress proxy written in the engine on Node's built-in modules | Owner, 2026-11-11 (decision card) |
| 8 | 2026-11-11 | OQ-6: base image is the official Node LTS image on Debian slim | Owner, 2026-11-11 (decision card) |
| 9 | 2026-11-11 | OQ-7: secrets in the OS credential store through koffi | Owner, 2026-11-11 (decision card) |
| 10 | 2026-11-11 | Section 10: drafts of H-0080 (manifest owner keys), H-0081 (.gitignore) and H-0082 (interview tools, OQ-8) | — (drafts) |
| 11 | 2026-11-11 | OQ-9: Vitest | Owner, 2026-11-11 (decision card) |
| 12 | 2026-11-11 | Gate 1 #1: proxy as a sidecar container on an internal network | Owner, 2026-11-11 (decision card) |
| 13 | 2026-11-11 | Gate 1 #4: model credential through a gateway in the proxy | Owner, 2026-11-11 (decision card) |
| 14 | 2026-11-11 | Gate 1 #7: owner keys pinned, changes confirmed by the previous owner | Owner, 2026-11-11 (decision card) |
| 15 | 2026-11-11 | Gate 1 #19: OS credential store residual risk accepted with scoped tokens | Owner, 2026-11-11 (decision card) |
| 16 | 2026-11-11 | Gate 1 #20 decided (engine `fetch_page`, H-0083). All Gate 1 findings folded in: SR-1 to SR-23, sensitive data and external services, AC-14 to AC-21, pins in constraints, H-0082 limits and caps. OQ-10, OQ-11 added | Owner, 2026-11-11 (decision card, #20); rest drafts |
| 17 | 2026-11-11 | OQ-10: feature ids unique across projects, no channel change | Owner, 2026-11-11 (decision card) |
| 18 | 2026-11-11 | OQ-11: gitleaks as the secrets scanner | Owner, 2026-11-11 (decision card) |
| 19 | 2026-11-11 | H-0080 to H-0083 approved and applied | Owner, 2026-11-11 (decision card) |
| 20 | 2026-11-11 | gitleaks review folded in (pin 8.30.1, blob-only scanning) | — (review) |
| 21 | 2026-11-11 | OQ-4: five components approved with pins; readiness gate passed | Owner, 2026-11-11 (decision card); orchestrator (gate) |
| 22 | 2026-11-11 | FR-4 clarified: the engine reports channel 1.2 until the advisor increment | Owner, 2026-11-11 (decision card) |
| 23 | 2026-11-11 | H-0084: channel error code -32008 `refused` | Owner, 2026-11-11 (decision card) |
| 24 | 2026-11-11 | OQ-9 follow-up: test coverage by `@vitest/coverage-v8`, pinned, dev only | Owner, 2026-11-11 (decision card) |
| 25 | 2026-11-11 | H-0085: engine CI workflow on Linux, macOS and Windows | Owner, 2026-11-11 (decision card) |
| 26 | 2026-11-11 | H-0086: 45-minute limit per engine CI job | Owner, 2026-11-11 (decision card) |
| 27 | 2026-11-11 | Agent SDK peers: `legacy-peer-deps` in `engine/.npmrc` plus zod 4.6.7; other peers not installed | Owner, 2026-11-11 (decision card) |
| 28 | 2026-11-11 | Limits live in master defaults, projects may only lower them; H-0087 drafts the file, manifest v1.4 `limits:` and values | Owner, 2026-11-11 (decision card, location); values draft |
| 29 | 2026-11-11 | H-0087 approved: limit values, manifest v1.4 `limits` | Owner, 2026-11-11 (decision card) |
| 30 | 2026-11-11 | Skills, `AGENT.md` and limit defaults come from the master commit that `factory.version` names; a project's `agents.override` / `skills.override` (read from its config repo's `main`) win over them, and a factory pull never changes them | Owner, 2026-11-11 (decision card; thread message) |
| 31 | 2026-11-11 | `research_web` counts against the item being researched, else the open question, and always against the per-session cap | Owner, 2026-11-11 (decision card) |
| 32 | 2026-11-11 | Until F-002 is wired: analyst `claude-opus-5-5`, web reader `claude-haiku-5-5`, set in the master defaults file `engine/config/models.yaml`; per-project choice arrives with F-002's `settings.agents.<role>.rung` | Owner, 2026-11-11 (decision card) |
