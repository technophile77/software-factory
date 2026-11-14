# Proposal 0031: Agents on the owner's PC without containers until Beta

- **Raised:** 2026-11-13, by the owner ("revisit the decision to use an
  external container instead of using the claude isolated worktree")
- **Category:** Security (open decision 4, ADR 0015)
- **Status:** Decided: option B, by the owner on 2026-11-13 (decision card),
  accepting the risks in section 3 until Beta (ADR 0026)
- **Hygiene:** H-0200 (ADR and index), H-0201 (Role policy contract)

## 1. What Claude Code's isolated worktree does

`isolation: worktree` is a frontmatter field for Claude Code subagents. When
a parent session starts a subagent with it, the subagent works in a temporary
git worktree, which is branched from the default branch unless configured
otherwise. Claude Code then applies four checks
([worktrees, "How Claude Code enforces isolation"](https://code.claude.com/docs/en/worktrees.md#how-claude-code-enforces-isolation)):

- `Edit`/`Write` may not target the main checkout.
- A command may not run with its working directory in the main checkout.
- git may not be redirected into the main checkout.
- A command is refused when its git use can't be verified from its text.

The docs say what the checks leave out: "None of them tracks which files a
shell command writes, so a command that writes into the main checkout without
running git there, such as `cp` or a shell redirect, isn't refused by them."
The checks don't limit reads, network use, or files outside the repository.
Their purpose is keeping parallel work separate, not containing the code an
agent runs.

The factory already does that separation itself. The engine gives each
agent session its own git worktree on its own branch (ADR 0004), and checks
the branch diff against the role's write rules when the session ends
(ADR 0015). The engine runs each role as its own Agent SDK session, not as a
subagent (engine/src/agent/session.ts), so the frontmatter field would have
no effect on it.

## 2. What containers give today (ADR 0015, Role policy contract)

| Guarantee | Container | Without container |
|---|---|---|
| Agent code can't read the owner's home: SSH keys, gh and git credentials, Claude login, other repos | Yes, only the worktree is mounted | **Lost.** File-tool read rules still apply, but any command (npm, a test, a build script) runs as the owner |
| Agent can't use the owner's GitHub token | Yes, there are no tokens inside | **Lost.** ADR 0017 accepted the owner's token as the engine's token *because* "agents can't: they run in containers with no tokens" |
| Network limited to the model API and the role's hosts | Yes, through the egress proxy | **Lost** for commands. The proxy can still hold the model credential, but nothing stops `curl` or a package script reaching any host |
| CPU, memory and process limits (H-0087) | Yes | **Lost** unless the engine adds Windows Job Objects |
| Non-root, read-only root, no capabilities | Yes | **Lost**: agents run as the owner's account |
| Engine socket and `engine.json` out of reach | Yes | **Lost** for commands (file-tool denies remain) |
| Worktree and branch per session | Yes | Kept |
| File-tool path rules (read, write, secret-file denies) | Yes | Kept |
| End-of-session write check on the branch diff | Yes | Kept |
| Command allowlist | Guard rail | Kept for every role except the software developer and test engineer, who have a full shell until Beta (F-015). `npm`, `node` and test runners run repo code by design |
| Model credential kept from the agent (dummy key, proxy swaps it) | Yes | Partly kept: the proxy can run on the host, but agent code can read the owner's own Claude login from disk |

Claude Code's own sandbox can't stand in on native Windows: "On native
Windows, Claude Code runs commands unsandboxed. To use the sandbox on a
Windows machine, run Claude Code inside a WSL2 distribution"
([sandboxing](https://code.claude.com/docs/en/sandboxing.md)).

## 3. The risks, stated plainly

1. **An agent could act as the owner on GitHub.** A prompt injection in a
   repo, an issue (F-010) or a web page, or a malicious package, runs a
   command that reads the owner's token and merges a PR, approves an inbox
   item with a 👍 (ADR 0022), or pushes to main. GitHub can't tell this from
   the owner (ADR 0017's stated residual risk, which assumed agents had no
   token). Prompt injection is OWASP's top LLM risk
   ([LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)),
   and excessive permissions turn it into actions
   ([LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)).
2. **Secrets on the PC can leave it.** A package install script or test can
   read SSH keys, cloud logins and tokens and send them anywhere. This is
   exactly what the September 2025 "Shai-Hulud" npm worm did on developer
   machines ([CISA, 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)).
   The factory runs `npm install` and tests from agent-written code
   (F-015).
3. **Signed owner actions could be forged.** If the owner's SSH signing key
   has no passphrase, agent code can sign an owner action (ADR 0015
   decision 3).
4. **A runaway agent or test can slow or hang the PC** (no CPU, memory or
   process limits).
5. **Approved specs lose their guarantees.** These approved requirements say
   "own container" or "no network but the model API" and would no longer hold:
   F-007 (container rules, SR-18 limits), F-008 FR-2, AC-3 and SR-6 (Security and Testability Review
   reviewer), F-010 FR-4 and AC-5 (triager with no network and no writable
   mount), F-013 AC-17 (LiteLLM reachable only through the proxy), F-016
   SR-11 (readiness session), F-015 FR-3 and OQ-6 (draft).

## 4. What changes if containers are dropped for now

- **Engine:** the session spawns Claude Code on the host with the worktree
  as its working folder instead of `docker run`. The proxy sidecar becomes a
  host process. The tool gate translates host paths instead of
  `/workspace` paths. The H-0087 limits and the network setup go unused.
  Containers stay in the code for later.
- **How agents run:** keep one Agent SDK session per role in the engine's own
  worktrees. Do **not** move to one Claude Code session that launches the
  roles as subagents with `isolation: worktree`. ADR 0001 rejected that
  because gates would then depend on the model following instructions, and
  subagent worktrees branch from main, not the feature branch.
- **LiteLLM (F-013):** either keep Docker for the router alone (Docker stays
  a requirement), or run it as a host Python process. It has 46 CVEs that
  were accepted on the basis that it runs in a container until 2026-12-13.
  **Decided 2026-11-14 (owner, decision card):** it stays in its own
  container, started only when a project configures a model endpoint.
- **Documents:** a new ADR amending ADR 0015 decision 1 (decisions 2 and 3
  stay). Update ADR 0004 status, ADR 0017's residual risk, and Role policy
  contract container rules (H-0200). Re-open the affected SRs in F-007,
  F-008, F-010, F-013 and F-016, and F-015 FR-3/OQ-6, each with the owner's
  acceptance of the risk. Security standards S8 (least privilege) needs a
  stated exception.
- **What the owner gains:** no Docker Desktop requirement, sessions start a
  few seconds faster, and agents use the toolchain already on the PC, so
  F-015 OQ-6 goes away.

## 5. Options

| | Option | Effect |
|---|---|---|
| A | **Keep containers** | No rework. Every approved guarantee holds. Docker Desktop stays required. F-015 OQ-6 must still be answered |
| B | **Drop containers until Beta** | Agents run on the host in the engine's worktrees. Risks 1 to 5 are accepted until Beta. Rework across the engine and five specs |
| C | **Drop them, but take the owner's token out of reach** | As B, but agents run under a separate local Windows account with no access to the owner's home or tokens (ADR 0014 option A). Removes risks 1 to 3. Network and resource limits are still lost. One admin prompt at setup |

**Recommendation at the time: A.** The owner chose B. The containers are already built and tested across
increments 1 to 3. The main daily cost is Docker Desktop, which the PC
already runs. Claude Code's isolated worktree adds nothing the engine's own
worktrees don't already give. If the owner wants containers gone, C keeps the
most important protection: agents can't act as him on GitHub.

## 6. H-0202 draft: requirement wording until Beta (not taken)

The owner chose on 2026-11-14 (decision card) to reopen F-007, F-008 and
F-010 each through its own interview instead. This draft is kept as the
starting point for those interviews.

Each requirement keeps its id and its original text, which takes effect
again at Beta. Until then, the text below applies. Each spec gets one line
under its requirement table: "Until Beta, ADR 0026 replaces the container
wording of the rows marked † with the H-0202 text in proposal 0031."

| Spec | Id | Until Beta |
|---|---|---|
| F-007 | FR-8 | The analyst and the web reader run as Agent SDK sessions on the owner's PC, each in its own engine worktree, under the Role policy contract's "until Beta" rule (ADR 0026). They get no owner credentials in their environment. Their model traffic goes through the engine's proxy. If the worktree or proxy can't be set up, no session starts. |
| F-007 | AC-16 | Given a running analyst session, the model credential appears nowhere in its environment, its arguments or its worktree. |
| F-007 | SR-6 | Suspended until Beta. The session's model traffic goes only to the proxy, but nothing at the OS limits other network use (accepted risk, ADR 0026). |
| F-007 | SR-9 | Unchanged except "container" reads "session": the session gets the proxy as its API base URL and a dummy key. |
| F-007 | SR-18 | Session caps unchanged. The container limits on CPU, memory, pids and temp size are suspended until Beta (accepted risk 4, ADR 0026). |
| F-008 | FR-2 | The reviewer runs as an Agent SDK session on the owner's PC under the project's `security-reviewer` role policy and the "until Beta" rule. The tool gate allows its one write, its named report. The end-of-session check rejects any other worktree change. |
| F-008 | AC-3 | Given a Security and Testability Review session, its tools are only `Read`, `Grep`, `Glob`, `Write` and `Skill`, and its model traffic goes to the proxy. |
| F-008 | SR-6 | Same caps and billing check as the analyst (F-007 SR-18 as above). |
| F-008 | SR-8 | "After the container is gone" reads "after the session has ended". The rest is unchanged. |
| F-010 | FR-4, AC-5, SR-2 | The triager runs as a session on the owner's PC with one tool, `submit_triage`, and no file tools, so it reads only its input. No network and no write still hold, through the tool list rather than the container. |
| F-010 | SR-25 | Confirmation writes only its test (tool gate and end-of-session check) and fetches nothing named in an issue. "No network" is not enforced for the test it runs until Beta (accepted risk 2, ADR 0026). |
| F-010 | A-2 | "In the agent container" reads "on the owner's PC". |

Not covered here: F-013 (unchanged, since LiteLLM stays in its container), F-015 and F-016
(drafts, owned by their threads), F-006 FR-7 and SR-9 (a future shell,
unchanged until it is proposed).
