# F-015 Security and Testability Review (requirements review)

- **Feature:** F-015 Build a feature to a pull request on the real engine,
  spec v18 (OQ-1 to OQ-7 decided; H-0190 to H-0196 approved)
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-14
- **Maturity level:** Rapid prototype (the engine repo's level). Only
  Critical findings block there.
- **Result:** 14 findings: 0 Critical, 4 High, 9 Medium, 1 Low. Nothing
  blocks at Rapid prototype. The High ones block at Alpha, so they are
  proposed as requirements now (SR-2 to SR-15). Two need the owner to choose
  (#1, #5).
- **Not re-opened (owner decisions):** no containers until Beta (ADR 0026)
  and its five accepted risks; full shell for developer and test engineer
  (SR-1); the credentialed-CLI ask rule (Role policy v2.7, H-0201); PRs with
  the owner's fine-grained token (ADR 0017); Semgrep from the hash-pinned
  venv with six advisories accepted until 2027-02-12 (H-0196); commits as the
  owner, noreply address, unsigned (FR-17); one code repo per feature (OQ-3);
  test engineer after the developer (H-0192). Several findings below reduce
  risk *inside* those decisions; none removes the SR-1 residual, which stays:
  anything an agent or its code runs can act as the owner until Beta.

## Security and Testability Review checklist

| Question | Answer |
|---|---|
| Touches input, auth, secrets, sensitive data, dependencies, external systems? | All six. Input: JUnit XML, test output, CI results, PR comments, GitHub profile name, manifest commands. Auth: the owner token on code repos, `/changes` actor check. Secrets: the token, anything on the owner's PC that agent code can reach (SR-1). Sensitive data: spec, transcript, Gate reports, test logs, local paths (S3.2 list in #3). Dependencies: an XML parser (#7), Semgrep venv (H-0196). External: GitHub code repos, possibly public; package registries; `semgrep.dev`. |
| Permissions needed; each the minimum (S8)? | Not stated for the token on code repos (#1). Agent shells are wider than minimum by owner decision (SR-1). The test run's environment is not stated (#8). See "Permissions added". |
| New or upgraded external component; S4.1 review and CVE check? | Semgrep venv: done (ADR 0024 amendment). A JUnit XML parser is needed and not named; it needs S4.1 or must be the platform's own (#7). Build tools are the owner's own (OQ-6 superseded), outside the factory's S4 scope; stated as residual. |
| Reads from or acts on anything external; scope stated, irreversible actions to the owner, threat model? | Section 9 has no S9.1 list and no S9.7 threat model (#13; both supplied below). Pushes and PRs are exempt from S9.2 under ADR 0017, but publishing to a public repo needs a stated rule (#5). Agents can act outside the engine through the owner's git and registry credentials (#6). |
| Is there a requirement for each? | Only SR-1. Proposed SR-2 to SR-15 below. |
| Abuse cases in the edge cases? | Section 6 has one (public target repo) and no attacker cases. List below, to add to section 6. |
| Needs the owner's decision (Security)? | #1 token layout, #5 publishing to a public code repo; plus approval of SR-2 to SR-15 and the Role policy change in #6 (an Interfaces hygiene item). |

## Permissions added (S8.5)

| Permission | Holder | Reason | Status |
|---|---|---|---|
| Owner token on each target code repo: write branches, open and update PRs, comment, read checks; merge for FR-10 only | Engine | Stage 9 (FR-10, FR-14) | Not stated in the spec; widening needs the owner (#1) |
| Full `Bash` on the owner's PC, owner's rights, open network | Developer, test engineer | Build and test with the owner's toolchain | Accepted risk (SR-1) |
| `Read`, `Grep`, `Glob`; writes only its report | Orchestrator (classifier) | Classify failures (FR-7) | In H-0192; fine |
| Run manifest-declared `test` and `build` argv on the host | Engine | FR-6 | Under ADR 0026; environment and executable resolution unstated (#8) |
| Validation judge and Code Review reviewer read the diff and reports | Judge, reviewer | FR-8, FR-9 | Existing role policies; tool lists not restated in this spec (state them in H-0192) |
| Network to `semgrep.dev` (rules) | Engine's Semgrep step | FR-8 | Approved (ADR 0024) |

## External services (S9.1)

To go into section 9 as SR-2 (with #1's token decision):

| Service | Read | Act |
|---|---|---|
| GitHub, target code repo (owner token) | Repo metadata and visibility, `main`, PR state, head SHA, required checks for the head SHA, owner comments on managed PRs | Push `feature/F-nnn-name` only; open draft PR; mark ready; update its own PR title and body; post the FR-9 comment and FR-10 diff-mismatch comment; merge only under FR-10 |
| GitHub, config repo (owner token) | As F-011 SR-1 | As F-011 SR-1; push config feature branch and `factory/state` |
| Package registries | Agents and test commands download packages (open network under SR-1) | None allowed: publishing is held by the ask rule (#6) |
| `semgrep.dev` | `p/default` rules | None |
| Anthropic API | Model calls via the credential proxy | As F-007 |

## Threat model (S9.7)

Assets: the owner token and other credentials on the PC; private specs,
transcripts and reports; the code repo's `main`; the owner's attention
(inbox). Attackers: prompt injection reaching an agent (spec text is the
owner's, but dependencies, test output, CI logs, web content and public PR
comments are not); a malicious or compromised package; an outsider on a
public repo; a confused agent acting in good faith.

| STRIDE | Threat | Control |
|---|---|---|
| Spoofing | Another account comments `/changes`; a non-Actions check run reports a required check green | Numeric owner id, first-line command, unedited (F-011 SR-2, SR-18); checks bound to source and head SHA (#10) |
| Tampering | Agent edits CI workflows or test harness so CI is green on broken code; stale or planted JUnit file; hygiene PR changes between compare and merge | #2; results file rules (#7); merge bound to compared SHA (#11) |
| Repudiation | Unsigned commits in the owner's name; agent pushes outside the engine | Accepted (FR-17); engine log of every external action (SR-2); agent pushes held (#6) |
| Information disclosure | Spec, transcript, Gate findings, test logs, local paths or secrets reaching a public repo or PR; host files pulled in through XML entities or a symlinked results file | #3, #4, #7 |
| Denial of service | XML bomb; endless test output; runaway test process; CI never reports | #7; caps in H-0190 plus process-tree kill (#8); `ci_wait_minutes` |
| Elevation of privilege | Agent code using the owner's token, git credential or registry login; PR code getting CI deploy secrets; token with Workflows or Administration | SR-1 residual (accepted); #1, #6, #12 |

OWASP Top 10 for Agentic Applications (OWASP GenAI Security Project,
<https://genai.owasp.org>):

| Risk | Where here | Finding |
|---|---|---|
| ASI01 Agent goal hijack | Test output, code comments or CI logs steering the classifier, Code Review or the judge | #9 |
| ASI02 Tool misuse and exploitation | Shell used for `git push`, `npm publish` | #6 |
| ASI03 Identity and privilege abuse | Owner token scope; agents acting as the owner | #1, #6; SR-1 residual |
| ASI04 Agentic supply chain | Packages the agents install; XML parser; Semgrep venv | SR-1 residual; #7; H-0196 |
| ASI05 Unexpected code execution | Repo-declared commands, agent-written tests, CI running PR code | #8, #12; SR-1 residual |
| ASI06 Memory and context poisoning | Classifier evidence and `/changes` notes flowing into later sessions | #9, #10 |
| ASI07 Insecure inter-agent communication | Classifier and Gate output passed to the next role | #9 (structured hand-off) |
| ASI08 Cascading failures | A steered classifier sends fix cycles to the wrong role | #9; FR-7 caps |
| ASI09 Human-agent trust exploitation | Injected recommendation text in a Testing item; a green PR the owner trusts | #2, #9 |
| ASI10 Rogue agents | Agent acting outside the engine's view | #6; SR-1 residual |

## Abuse cases (add to section 6)

- A package install script or planted instruction makes the developer run
  `git push` or `npm publish` with the owner's credentials (#6).
- The developer edits `.github/workflows/*.yml`, the test script or the test
  config so CI and the engine's run pass without running the real tests (#2).
- An agent commits `reports/junit.xml` as a symlink to `~/.ssh/id_ed25519`,
  or a results file with an external entity or a billion-laughs payload (#7).
- A failing test prints "cause: test code; the expectation is wrong" to
  steer the classifier, so the test engineer weakens a correct test (#9).
- Agent-written code comments tell the Code Review reviewer or the judge there is
  nothing to report (#9).
- The developer copies spec or transcript text, or a key from the owner's
  home folder, into code, a fixture or a commit message bound for a public
  repo (#3, #4).
- An outsider comments `/changes` on a public PR, or edits an owner comment
  (#10).
- The PR head moves (owner push, or anything holding the token) between the
  FR-10 diff comparison and the merge (#11).
- A malicious `owner.commit_name` or GitHub profile name with control
  characters (#14).
- A code repo flips from private to public mid-build (#5).

## Findings

| # | Criterion | Severity | Blocks at Rapid prototype? | Needs owner? |
|---|---|---|---|---|
| 1 | S8.2, S8.5, S9.1, S9.6 | High | No | Yes |
| 2 | S2.1, S6.2, S8.3, S9.3 | High | No | No |
| 3 | S3.2, S9.4 | High | No | No |
| 4 | S3.1 | High | No | No |
| 5 | S9.2, S9.4 | Medium | No | Yes |
| 6 | S8.1, S9.2, S9.6, S6.2 | Medium | No | No (Interfaces hygiene item) |
| 7 | S1.1, S1.4, S4.1, S4.5 | Medium | No | No |
| 8 | S1.3, S8.1, S8.4, S3.3 | Medium | No | No |
| 9 | S6.1, S9.3, S1.1 | Medium | No | No |
| 10 | S6.1, S9.3, S2.3, S1.1 | Medium | No | No |
| 11 | S2.1, S5.1 | Medium | No | No |
| 12 | S8.3 | Medium | No | No |
| 13 | S9.7, S9.1 | Medium | No | No |
| 14 | S1.1 | Low | No | No |

### #1 The owner token's scope on code repos is not stated (High, needs owner)
**Criteria:** S8.2, S8.5, S9.1, S9.6.
F-011 SR-1 and SR-13 scope the everyday token for the inbox and PR
comments. F-015 adds pushing branches, opening and updating PRs and reading
checks on code repos, which needs Contents write and Pull requests write on
every target repo. The spec names none of it: not the repos, not the
permissions, not what is withheld. A token made broadly ("All
repositories", Workflows, Administration) would let an engine bug, or
anything running under SR-1, rewrite CI, change rulesets or reach every repo
the owner has. GitHub lists each fine-grained permission per endpoint
([GitHub docs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)).
A fine-grained token covers one resource owner only, so a project whose
code repos sit under an organization needs a token for it anyway.

**Options:**
- (a) **One token per project and resource owner**, "Only select
  repositories" = that project's config repo and code repos; permissions
  exactly Metadata read, Contents read/write, Pull requests read/write,
  Issues read/write, Checks read, Commit statuses read, Actions read; no
  Workflows, no Administration, no other permission. Simple; Issues write
  reaches code repos needlessly.
- (b) Two tokens: the inbox token as F-011 SR-13 (config repo) and a build
  token for code repos only (Contents, Pull requests, Checks, Commit
  statuses, Actions read; no Issues). Narrower, but both sit in the same
  credential store, which SR-1 code can read, so the gain is mainly against
  engine bugs; two expiries to manage.
- (c) `machine_account` mode for code repos (ADR 0006/0017 option C).
  Strongest separation from the owner's own access; the owner declined a
  second account in ADR 0017.

**Recommendation:** (a), because (b)'s gain is small while SR-1 stands, and
revisit with containers at Beta.

**Suggested SR-2:** "External services and token (S9.1, S8.2): the engine
acts on code repos only as the S9.1 table in section 9 lists. It uses a
fine-grained owner token limited to the project's selected repos, with
Metadata read, Contents read/write, Pull requests read/write, Issues
read/write, Checks read, Commit statuses read and Actions read, and no
Workflows or Administration permission; at most 90 days' expiry (F-011
SR-13). At start the engine checks that the token reaches no repo outside
the project and that a write to `.github/workflows/` is refused; otherwise
the project stops with a Security item. Each push, PR create or update,
comment and merge is logged with action, repo, ref or PR, head SHA, time
and approval id, without the token (S9.6)."

### #2 Agents can make CI and the engine's test run green without real tests (High)
**Criteria:** S2.1, S6.2, S8.3, S9.3.
For a `pull_request` event from a branch in the same repo, GitHub runs the
workflow files as they are on the PR head. A developer who edits
`.github/workflows/*`, the script behind `commands.test`, or the test
runner config can make the required checks and the engine's FR-6 run pass
without running the tests. Definition-of-done item 12 then certifies
itself. The developer's `write.deny` in the example policy covers only
`tests/acceptance/**`; a shell bypasses file-tool checks until the session
ends (SR-1), and the end-of-session check only applies the project's
globs. Also, required checks matched by name can be satisfied by a check
from another source.

**Suggested SR-3:** "Neither agent may change CI or test harness files:
`.github/workflows/**`, `.github/actions/**`, the files named by
`repos[].commands`, the test-runner config files listed per repo at
onboarding, and the path of `test_results`. These are in both roles'
`write.deny` by default, and the end-of-session check rejects changes to
them with a Security item. The token has no Workflows permission (SR-2),
so such a push fails at GitHub too. The engine reads only the required
checks named in the `main` ruleset, each pinned to the GitHub Actions app
as its source (ruleset `integration_id`), on the exact head SHA it pushed;
a check from another source or SHA is ignored."

### #3 Private material can reach a public code repo through the PR, comments, commits or code (High)
**Criteria:** S3.2, S9.4; owner rule (no sensitive information in public
repos; ADR 0028).
ADR 0028 keeps the spec and records in the config repo, but the spec still
lets private material reach the code repo: the PR title and description,
the FR-9 definition-of-done comment (items 3 and 7 are the Gate reports;
The Code Review's non-blocking findings are known, unfixed weaknesses), test output
with local paths and environment values, per-edit commit messages, the
whole per-edit history (including content added and later deleted), branch
names, and spec or transcript text an agent copies into code or comments.
The spec also does not identify its sensitive data (S3.2), and AC-1 reads
as if branches exist on GitHub from stage 5.

**Suggested SR-4:** "Sensitive data (S3.2): the owner token; the spec,
transcript, Gate and agent reports, run records, test output and logs; and
the owner's local paths and user name. None of it goes to a code repo or
its PRs. Anything written to a code repo or PR comes from fixed engine
templates: the PR title is `F-nnn: <feature title>`, the description holds
the feature id, spec version and a link to the spec at its approved
commit; the FR-9 comment holds pass or fail per definition-of-done item and
links into the config repo, never finding text, test output, logs or
paths. Commit messages are engine-written from fixed text and the file
list. Nothing is pushed to a code repo before stage 9, and only
`feature/F-nnn-name` is pushed; agent branches stay local. Before pushing
to a public repo the engine checks the pushed range for text that matches
the spec or transcript verbatim over 200 characters or more; a hit stops
the push and files a Security item quoting only the file and line."

### #4 The secrets scan does not cover everything that reaches a code repo or PR (High)
**Criteria:** S3.1.
FR-4 scans before each engine commit. Not covered: commits an agent makes
itself in its shell, the engine's merge commit of `dev` and `test`, the
history pushed in stage 9, PR title, body and comments. With a full shell,
an agent (or a planted instruction) can read keys from the owner's home
folder and put them in a fixture. The scanner (gitleaks, F-007 SR-19) by
default also honours a `.gitleaks.toml`, `.gitleaksignore` or inline
`gitleaks:allow` in the scanned repo, which an agent can write. A live
credential in a public repo is the standard's Critical example; here it
needs the precondition of an agent copying one, so High.

**Suggested SR-5:** "Before any push to a code repo the engine runs the
secrets scan on every commit in the range to be pushed, not only the final
tree, and on every PR title, body and comment before posting. It runs with
the engine's own config only; repo-level allowlists (`.gitleaks.toml`,
`.gitleaksignore`, inline allow comments) are not honoured, as ADR 0024
does for `nosemgrep`, and a diff that adds one is a Code Review finding. A hit
stops the push or post, files a Security item with engine text only, and
keeps the feature where it is."

### #5 Publishing to a public code repo has no stated rule (Medium, needs owner)
**Criteria:** S9.2, S9.4.
ADR 0017 exempts the factory opening its own PRs from S9.2. On a public
repo the first push publishes the code and its history to everyone, which
cannot be undone, and section 6 only notes the case. Visibility can also
change during a build.

**Options:**
- (a) Keep the ADR 0017 exemption as is; rely on SR-4 and SR-5.
- (b) Onboarding records each code repo's visibility and the owner confirms
  once per public repo that the factory may publish there; the engine
  re-reads visibility before each push and stops with a Security item if it
  differs from the recorded one.
- (c) A Security item before the first push of every feature to a public
  repo.

**Recommendation:** (b): one decision per repo, and it catches a repo that
turns public mid-build.

**Suggested SR-6 (for b):** "The engine pushes to a public code repo only if
the owner confirmed publishing to that repo at onboarding. Before each push
it reads the repo's visibility; if it differs from the recorded value, it
pushes nothing and files a Security item."

### #6 Agents can publish or push outside the engine with the owner's credentials (Medium)
**Criteria:** S8.1, S9.2, S9.6, S6.2.
The Role policy v2.7 ask list holds `gh`, cloud CLIs, `docker` and `ssh`,
but not `git push`, `git remote` or registry publishing (`npm publish`,
`twine upload`, `cargo publish`). An agent's shell can push any branch to
any repo with the owner's git credential manager, skipping every stage 9
check, and publish a package with the owner's `.npmrc` login. This is
inside SR-1's accepted risk for code the agent runs, but it is also the
obvious step a good-faith agent takes ("push my work"), so a rule catches
most of it.

**Suggested SR-7:** "Agent worktrees come from an engine-owned local clone
with no remote and `credential.helper` set empty in its config; the engine
pushes from its own separate clone. Role policy adds `git push`,
`git remote`, `git credential`, `npm publish`, `npm login`,
`twine upload` and `cargo publish` to the ask list (Interfaces change,
hygiene item). Residual (SR-1): code the agent runs can still use the
owner's credentials directly."

### #7 The JUnit results file is untrusted input with no parsing rules (Medium)
**Criteria:** S1.1, S1.4, S4.1, S4.5.
The file is written by agent-written test code (FR-6). Unstated: XML
external entities and DTDs (reading host files into the run report, then
into the classifier, Testing items or a PR comment,
[CWE-611](https://cwe.mitre.org/data/definitions/611.html)); entity
expansion bombs ([CWE-776](https://cwe.mitre.org/data/definitions/776.html));
size and depth limits; the path being a symlink out of the worktree
([CWE-59](https://cwe.mitre.org/data/definitions/59.html)); a results file
committed to git or left from an earlier run passing as fresh. The spec
also needs an XML parser, which is a new runtime library (S4.1, section 5).
Guidance: [OWASP XXE Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html).

**Suggested SR-8:** "The engine deletes the `test_results` path before each
run and refuses it if it is tracked in git. After the run it opens the path
under the ADR 0015 real-path rule, refuses a symlink, a non-regular file or
a file over 5 MiB, and parses it with DTDs, external entities and entity
expansion disabled, a depth limit, and a fixed schema (testsuite, testcase,
failure, error, skipped, system-out, system-err); other elements are
ignored and text fields are capped at 8 KiB each. Any refusal makes the run
incomplete. The parser is an approved library after an S4.1 review, or
engine code with no new dependency."

### #8 The engine's test and build commands run with the engine's environment (Medium)
**Criteria:** S1.3, S8.1, S8.4, S3.3.
Argument arrays and no shell (H-0193) cover injection. Unstated: the
environment the command inherits (the engine may hold tokens or the proxy
credential in its environment), how the program name is resolved (on
Windows the search starts in the current directory, which is the agent's
worktree; `.cmd` files such as `npm.cmd` can't be spawned without a shell
since Node's fix for CVE-2024-27980, which tempts `shell: true`), killing
the whole process tree at the cap, and output going into reports unscanned.

**Suggested SR-9:** "The engine runs `commands.test` and `commands.build`
with an allowlisted environment (PATH, HOME or USERPROFILE, TEMP, locale
and the toolchain variables onboarding records), never the engine's own
environment, so no token, proxy credential or engine socket path is passed.
`argv[0]` is resolved to an absolute path outside the worktree before the
run; a `.cmd` or `.bat` target is run through `cmd.exe /d /s /c` with each
argument escaped by the engine, never with `shell: true`. At the H-0190
caps the whole process tree is killed. Kept output passes the secrets scan
before it is stored, and the owner's home path is replaced by `~`."

### #9 Agent-written output can steer the classifier, Code Review and the judge (Medium)
**Criteria:** S6.1, S9.3, S1.1.
The classifier reads test output and failure messages produced by code the
agents wrote; Code Review and the judge read the diff. Planted text can name a
cause ("the expectation is wrong" sends a correct test back to the test
engineer to be weakened; "environment" buys reruns) or tell a reviewer
there is nothing to report. Its evidence text then reaches the owner in a
Testing item. The classifier has no tools to act, so the harm is a wrong
decision, not an action.

**Suggested SR-10:** "Test output, failure messages and diff text are given
to the classifier, Code Review and the judge as labelled data blocks after the
instructions (F-008 SR-7), output truncated to the H-0190 cap. The
classifier's report is validated by the engine: each failure id must exist
in the results file, the cause must be one of the failure table's causes,
evidence is at most 2 KiB per failure; anything else makes the
classification invalid and the run goes to a Testing item. Evidence is
rendered in Testing items under F-011 SR-10. When a failure classified
`test code` is fixed by changing that test, the judge receives the list of
those test changes with the spec section each cites."

### #10 CI results and PR comments are not bound to the engine's own head (Medium)
**Criteria:** S6.1, S9.3, S2.3, S1.1.
FR-10 reads required checks "on the PR head", but the head can move (owner
push, anything with the token) between push and the check read, and a
`/changes` comment arrives from a repo that may be public. F-011 SR-2,
SR-4 and SR-18 cover the actor and command form; the spec does not say the
note is size-capped, that only the PR the engine opened counts, or what
happens when the head is not the SHA the engine pushed. If red CI goes back
to stage 6, CI logs written by agent code reach the classifier.

**Suggested SR-11:** "The engine marks a PR ready only when every required
check (SR-3) passed on the SHA the engine pushed and that SHA is still the
PR head; if the head differs, the PR stays draft and the feature is
`blocked` with a Decision item. `/changes` is read only on PRs the engine
opened, from the owner's numeric id, under F-011 SR-18; the note is at
most 4 KiB, goes to the orchestrator as data (F-011 SR-4) and never to an
agent as instructions. CI logs used in stage 6 are fetched by the engine,
capped like test output (H-0190) and handled under SR-10."

### #11 FR-10 hygiene auto-merge is open to a race and to the wrong PR (Medium)
**Criteria:** S2.1, S5.1.
F-011 SR-11 compares the diff byte for byte, but the spec does not tie the
merge call to the commit compared ([CWE-367](https://cwe.mitre.org/data/definitions/367.html)),
nor say where the approved diff comes from, nor limit auto-merge to the
repo and PR the hygiene item names. A push after the comparison would be
merged on the owner's approval of different content.

**Suggested SR-12:** "FR-10 merges only the PR the engine opened for that
hygiene item, in the repo the item names, never a `feature/` branch. The
approved diff is the one the engine stored with the item at approval, by
hash. The merge call passes the compared head SHA (`sha`), so GitHub
refuses it if the head moved; required checks must be green on that SHA.
Any failure merges nothing and comments under FR-10."

### #12 CI runs agent-written code with the repo's secrets (Medium)
**Criteria:** S8.3.
A `pull_request` workflow on a branch in the same repo gets the repo's
secrets and a write-capable `GITHUB_TOKEN` unless the workflow narrows it.
Agent-written code and tests run there. A code repo with deploy keys or
cloud credentials in Actions secrets hands them to that code. This depends
on F-003 onboarding, which prepares the CI workflow and ruleset.

**Suggested SR-13:** "Before opening the first PR in a code repo, the engine
checks (or F-003 onboarding records) that workflows triggered by
`pull_request` declare `permissions:` read-only and pass no secrets other
than `GITHUB_TOKEN`, and that no deploy environment is reachable from them.
A repo that fails gets no PR; the engine files a Security item naming the
workflow."

### #13 Section 9 lacks the S9.1 service list and the S9.7 threat model; section 6 lacks abuse cases (Medium)
**Criteria:** S9.7, S9.1; Security and Testability Review checklist.
F-015 has the factory's widest external surface so far and its section 9
holds only SR-1. This report supplies the S9.1 table, the threat model and
the abuse cases above.

**Suggested SR-14:** "The S9.1 table, STRIDE threat model and OWASP Agentic
Top 10 mapping in `F-015-security-testability-review.md` are part of this spec; a change
to the external services or their read/act scope reopens Security and Testability Review." Add the
abuse cases above to section 6.

### #14 Commit identity fields are not validated (Low)
**Criteria:** S1.1.
`owner.commit_name` and the GitHub profile name are input. Control
characters, newlines or `<`/`>` could produce misleading author lines or
fail commits unpredictably.

**Suggested SR-15:** "The commit name, from the manifest or GitHub, is
1 to 100 characters with no control characters, `<` or `>`; otherwise the
login is used and a Notice is filed. The account's numeric id from the API
must equal the pinned `owner.github_id`, or the project stops with a
Security item. Name and email reach git only through `GIT_AUTHOR_*` and
`GIT_COMMITTER_*`, never as arguments."

## Residual risk (unchanged, for the record)
- SR-1 / ADR 0026 risks 1 to 5: code the agents write or install runs as
  the owner and can use any credential on the PC, including the token in
  #1, the git credential in #6 and package-registry logins. #1, #6 and #8
  narrow the paths the factory itself opens; none closes this until
  containers return at Beta.
- Unsigned commits in the owner's name (FR-17): anyone can forge the same
  author line; GitHub shows them unverified.
- Semgrep's six accepted advisories (H-0196), expiring 2027-02-12.
