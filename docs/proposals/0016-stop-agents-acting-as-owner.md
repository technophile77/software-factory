# Proposal 0016: Stop agents answering in the owner's place

**Status:** proposed for the owner's decision. Raised as F-005 SR-5, an
accepted risk that must be closed before Alpha. Not a decision until the
owner chooses; the outcome becomes an ADR and contract changes (hygiene ids
H-0050 to H-0054).

Category: Security (with Architecture and Interfaces consequences).

## Problem

At Rapid prototype every agent runs as the owner's OS user. Anything an agent
runs (its own tools, or code it builds and tests) can therefore do whatever
the owner's user can:

1. Connect to the engine channel and send `interview.reply`,
   `approve_assumption` or `feature.start` as if it were the owner (SR-5).
2. Read the owner's credentials: the `gh` token, the Git credential manager,
   browser cookies, Claude Code's own session history.
3. Use those credentials, so GitHub sees the owner's login doing it. This is
   why an approval "attested by GitHub" (F-003 R2-4) is not proof either
   while agents run as the owner.

The engine already refuses connections from processes it started, and the
role policy denies every role `.factory/engine.json` (SR-14). These are guard
rails: an agent's child process, or a `Bash` command that reads the file
anyway (R2-1), gets past them.

## The finding that shapes the options

Any check that happens once and then hands out a session token is defeated
while agents run as the owner. The owner passes the check, the engine issues
a token, and the token is then in places the owner's user can read: the
client's memory, the Claude Code session history under the owner's home
folder. An agent waits for the owner to open a session and uses the token.

So a check run as the owner's user only holds if it is made **per reply**
and binds the reply's content, or if agents are moved to **another OS
identity** so they cannot read the owner's files at all.

## Options

### A. Agents run as a separate OS account (recommended)

The engine keeps running as the owner (ADR 0003). It launches every agent
session as a dedicated local account, for example `factory-agent`, which
holds only the factory's machine-account token (ADR 0006) and its own model
API credentials, never the owner's.

- **How it stops the problem:** the channel already accepts only the owner's
  uid or SID (SR-8, SR-7), so a `factory-agent` process is refused at
  connect. It can't read `engine.json` (owner-only directory), the owner's
  `gh` or Git credentials, browser profile, or Claude Code history.
- **Covers more than SR-5:** it is the OS boundary F-003 R2-1 asks for, and it
  makes GitHub attestation (R2-4) mean something, since agents no longer hold
  the owner's GitHub login.
- **Owner effort:** one-time setup of the account, done by onboarding with one
  admin prompt. Nothing extra per session or per answer.
- **Windows:** a standard local account. The engine starts agents with
  `CreateProcessWithLogonW`, using the account's password stored in the
  owner's Credential Manager (readable by the owner's user, not by the agent
  account). Worktrees get an ACL that gives the account access to its own
  worktree only.
- **macOS / Linux:** a system user, launched through one narrow `sudoers`
  rule that allows only the engine's agent launcher. Worktrees use a shared
  group with owner-only `.factory`.
- **Costs:** the engine's launcher and file permissions get more complex, and
  must be tested on each OS. Builds the agents run need their own tool caches
  (npm, pip) under the account. A privilege-escalation bug in the OS would
  still break the boundary; that is accepted at Alpha.
- **Changes:** ADR 0004 ("agent-run code still has the user's OS
  permissions") is superseded on this point. Role policy and the engine gain
  the account name; onboarding creates the account.

Variant **A2: a container per agent** (considered in ADR 0004) gives the same
separation with stronger isolation, but needs Docker Desktop on Windows and is
slower. It can be added later, from Beta, without changing this design.

### B. Approve each session in GitHub on your phone

When a session opens, the engine starts GitHub's device sign-in for a
factory OAuth app. You type the shown code at github.com/login/device on your
phone and approve; GitHub tells the engine your account said yes.

- **Weakness:** it is a once-per-session check, so the session token can be
  taken as described above. An agent could also start its own device sign-in
  at the same moment and hope you approve the wrong code.
- **Owner effort:** a code to type at every interview session.
- **Use it for:** nothing on its own. It adds little once A is in place.

### C. Windows Hello, Touch ID or a security key on each reply

The skill asks the OS for a passkey signature over each reply (item,
revision, kind, text). The key never leaves the TPM or Secure Enclave, and
the signature needs your face, fingerprint, PIN or a touch.

- **Strength:** an agent can't produce the signature, even as your user. It
  binds the exact reply, so a stolen token is useless.
- **Weakness:** one prompt per answer. The prompt does not show the text you
  are approving, so an agent could still try to slip a prompt in while you
  expect one. Needs a small native helper per OS. Covers only the interview,
  not credentials or GitHub.
- **Use it for:** an optional extra on top of A for the highest-stakes
  replies (`approve_assumption`, `feature.start`), if you want two layers
  later.

### D. Authenticator code (Authy, Google Authenticator)

The engine asks for a six-digit code when a session opens.

- **Weakness:** to check the code, the engine must store the shared secret on
  your machine, where anything running as you can read it and make codes
  itself. Also once per session, so the token problem applies.
- Not recommended.

### E. Prove the session with a write to the repo (your idea)

When a session opens, the engine generates a value that must appear in a
given file on a branch only your GitHub account may push to. The engine
checks GitHub for the commit.

- **Plain push:** your Git credentials are readable as your user, so an
  agent can push it too.
- **Signed with a security key** (an `ed25519-sk` SSH signing key that needs a
  touch): an agent can't make the signature, so this is a real proof. It is
  then a presence check like C, done through GitHub, slower (a push per
  session) and once per session, so the token problem applies again.
- Not recommended on its own; C does the same job more directly.

## Comparison

| | Stops an agent answering as you | Stops agents using your GitHub login | Effort for you | Windows |
|---|---|---|---|---|
| **A. Separate OS account** | Yes | Yes | One-time setup | Yes |
| B. GitHub phone approval | Partly (token can be taken) | No | Code per session | Yes |
| C. Hello / Touch ID per reply | Yes, for interview replies | No | Prompt per answer | Yes |
| D. Authenticator code | No (secret readable) | No | Code per session | Yes |
| E. Repo write, plain | No | No | Push per session | Yes |
| E. Repo write, key-signed | Partly (token can be taken) | No | Touch and push per session | Yes |

## Recommendation

Choose **A**, run agents as a separate OS account, as the fix for SR-5 before
Alpha. It is the only option that also closes R2-1 and makes R2-4's GitHub
attestation trustworthy, and it costs you nothing per session.

Keep **C** on file as an optional second layer for assumption approvals and
feature starts, to decide at Beta. Drop B, D and E.

## How this fits with the other open items

- **F-003 R2-1 (OS sandbox for `Bash` roles), proposal 0017:** decided alongside this one.
  This proposal decides which OS identity agents run as. R2-1 decides the
  per-role filesystem and network rules applied inside that account. Claude
  Code's built-in sandbox does not run on native Windows, so on Windows the
  account boundary does most of the work.
- **F-003 R2-4 (forged inbox approvals), proposal 0017:** with A in place, "GitHub attests the
  owner's login did it" holds, because agents no longer have the owner's
  login. No separate phone flow is needed for it.

## Questions for the owner

1. Which option closes SR-5 before Alpha: A (recommended), B, C, or another?
2. If A: is one admin prompt during onboarding, to create the agent account,
   acceptable?
3. Should C be added now as a second layer, or kept on file for Beta
   (recommended)?

## Follow-on changes once decided (hygiene ids reserved)

| Id | Change |
|---|---|
| H-0050 | New ADR recording the choice; ADR 0004 amended on the OS-permissions point |
| H-0051 | Engine control channel: SR-5 text replaced with the account boundary; agent sessions run as the agent account |
| H-0052 | Role policy: the agent account name and what it may hold (factory token only) |
| H-0053 | F-005 spec SR-5 status, and onboarding (F-003) creates and checks the account |
| H-0054 | Reserved for C if the owner adds it |
