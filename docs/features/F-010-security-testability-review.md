# F-010 Security and Testability Review (requirements review)

- **Feature:** F-010 Triage GitHub issues into the factory, spec v14
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-12
- **Maturity level:** Rapid prototype. The factory repo has no manifest of
  its own, so this follows F-007's gates. Only Critical findings block
  there (Severity table, "What blocks a PR"). The fix lane also runs on
  managed repos, whose own levels set the bar for each fix PR.
- **Result:** 18 findings: 1 Critical, 2 High, 11 Medium, 4 Low.
  **#1 blocks.** It is in the fix lane (FR-7, FR-8), so triage and inbox
  routing could still go ahead after increment 3 while #1 is settled. Both
  High findings block at Alpha, so they should become requirements now.
  Four need an owner decision (Security): #1, #3, #5 and #9. The owner's
  decisions on OQ-1 to OQ-7, the caps and the "questions only" rule are not
  re-opened; the findings cover the risks they leave.
- **Is the FR-17 filter enough (SR-11)?** Not as written. It can be
  bypassed with a full-width dot, a spelled-out domain or a phone number,
  and GitHub turns some plain text into links. With the additions in #4 it
  is a reasonable bound on the risk the owner accepted.
- **Threat model (S9.7):** below, STRIDE checked against the OWASP Top 10
  for Agentic Applications.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S9.3, S6.1, S8.3, S3.1 | Critical | **Yes** | Reporter text reaches the sessions that write and run code. The record's `inputs` (2,000 characters), `expected` and `actual` are the reporter's own text by design: "the exact inputs supplied". The test engineer gets them (FR-7), and the generated fix spec carries them to the developer. A length cap is not validation for a model reader (S9.3 asks for "structured, validated results"). The plainest attack needs no clever injection. The reporter writes "minimal example to reproduce: `<script>`", with the script obfuscated. The test engineer copies it into the reproduction test, as it should for a repro. The engine commits it and pushes the branch. Most repos run CI on branch pushes and on same-repo PRs, and those runs get the repo's secrets. Fork PRs don't, but a factory branch isn't a fork. So the attacker's code runs in the owner's CI with the owner's secrets and open network, before Code Review, validation or the owner's review. It runs again on the owner's machine if the owner checks the PR out to try it. OQ-4 lets anyone do this on a public repo, 20 times a day. | **Owner decision (Security):** how reporter-derived code is kept away from secrets. Recommended, all of: (a) Confirmation and fix-lane branches stay local. Nothing is pushed until Code Review and validation pass, and the PR opens as a draft. (b) Before a repo's first fix lane, and whenever its `.github/workflows/` changes, the engine checks the workflows on `main`. If any workflow that triggers on push or `pull_request` for factory branches can read secrets (other than `GITHUB_TOKEN` with read-only permissions), the fix lane is refused for that repo. A Security item asks the owner to gate those secrets behind an environment that needs the owner's approval, or to accept the risk. (c) A record with `instructions_found: true` never enters the fix lane. It goes to the owner as a Security item instead. This adds a route; it doesn't change who may report (OQ-4). (d) Record text goes to the test engineer and developer as a fenced data file with a fixed frame, never inside the prompt prose, and the fix spec quotes it only inside that frame. (e) A reproduction test may not start processes, read environment variables, open network connections, decode and run code, or write outside the test's temp folder. Code Review checks this for every fix, and the PR body lists the reporter-derived inputs. Alternative: rely on the owner's PR review alone. Not recommended, because CI runs before that review. |
| 2 | S9.3, S2.1, S6.1 | High | No | An outside reporter can steer the factory into weakening a control. The record's `expected` is the triager's reading of the issue. The engine checks that `ref` exists at `main` (H-0113), not that it says what `expected` claims. A crafted issue can cite a real spec line and claim it allows `../` in paths, or a longer input, or an unsigned token. The test fails on `main` "for the stated reason", so the lane removes the check. Red, green and regression evidence all pass, because the regression suite may not cover the control. The scope guard (#11) catches only some files. The owner then reviews a PR that says "bug confirmed, all gates passed". Many such PRs teach rubber-stamping (ASI09). | Add SRs. (a) The test engineer derives the expected output from the cited evidence itself, from the spec, doc or release it reads at `main`, and its report quotes the evidence. A mismatch with the record means not confirmed. (b) For `evidence: crash`, the only expected change is no crash. The fix may change no other output, and Code Review checks it. (c) Code Review stops the lane and files a Security item if the fix removes or loosens input validation, authentication, authorization, a limit, escaping, or error handling, whatever files it touches. (d) The PR body starts with a fixed banner: from an outside issue, the reporter's GitHub association, `instructions_found`, the evidence cited, and the files changed outside tests. |
| 3 | S3.2, S9.4, S6.1 | High | No | Issue material is stored on `factory/state` in the managed repo (H-0111, ADR 0009), so it is public on a public repo. That covers every snapshot (written before the kind is known), every triage record, dropped questions (FR-17 "each drop is logged"), and the record, route and Security item for a `security_report`. Four problems follow. (a) It re-publishes vulnerability detail. If the owner deletes or edits the issue to contain a disclosure, the copy stays in Git history. (b) It undoes the FR-17 filter: a dropped question with a phishing link is still published, under a factory commit. (c) Abusive, illegal or personal content in an issue gets copied into the owner's repo, where GitHub's moderation can't remove it. (d) Section 9 names no sensitive data (S3.2). | **Owner decision (Security):** where issue material is stored. Recommended: in an owner-only store the engine keeps outside every repo (0700, files 0600, as F-007's logs), with a retention period. Alternatively, in the project's config repo, but only if the engine confirms through the API that it is private. `factory/state` keeps only what the owner needs to follow the routing, with no issue or model text: the snapshot hash, kind, route, ids, and the action log. `security_report` material never goes anywhere but the private store. The inbox item holds the issue number and nothing more. Add the list of sensitive data to section 9: issue text, author ids, reporter answers, triage records, dropped questions and redacted findings. Alternative: keep H-0111 as drafted and turn triage on only for private repos. |
| 4 | S1.2, S9.2, S6.1 | Medium | No | The question slot (SR-11, owner accepted the risk). FR-17 has gaps. (a) Strings are NFC-normalized, which doesn't fold `example．com` (full-width dot), and `example dot com`, `example[.]com` and `example (at) mail` aren't domains to a pattern check. (b) Phone numbers, wallet addresses and account numbers pass. (c) GitHub links plain text: a run of 7 to 40 hex characters becomes a commit link, and `GH-12`, `owner/repo#12` and `:shortcode:` are also rendered. (d) Spotting Markdown by pattern misses some cases; escaping is the S1.2 control. (e) Nothing stops the triager copying the reporter's own words into a question, which is the easiest way for an attacker to choose the text. (f) There is no secrets scan, word check or abuse check on a question. Abusive text posted by the factory account risks getting that account suspended, and then triage and PRs stop. | Add to FR-17 and SR-11. Run the checks on an NFKC-folded copy with confusables mapped to ASCII; post the original only if the folded copy passes. Drop a question that: has 6 or more digits in a run; has a hex run of 7 or more; contains `dot`, `at`, `[.]` or `(.)` between word-like tokens; matches `GH-\d`, `\w/\w+#\d` or `:\w+:`; mixes scripts within one word; or shares 6 or more consecutive words with the issue or the answer. It must start with an interrogative from a fixed list (What, Which, How, When, Where, Does, Did, Is, Are, Can, Could, Was, Were, Have, Has). Drop it on a fixed word list: credential, password, token, key, secret, login, sign in, install, download, run, execute, paste, pay, send, wallet, plus a profanity list. The secrets scan runs on the rendered reply. Fail closed: if the scan fails, nothing is posted. The engine backslash-escapes every Markdown-significant character in the question (S1.2). The template labels the questions as automated. Add a per-repo `questions: false` switch. The validation judge reviews a sample of posted questions each run. |
| 5 | S8.2, S8.5, S9.6 | Medium | No | `issues: write` "on those repos" (H-0114) can't be done with the one fine-grained token. A fine-grained token has the same permissions on every repo it selects, so triage on one repo grants issue writes on all of them. The spec doesn't say whose account posts. A token from the owner's own account would make every reply look like the owner (S9.6 forbids this), and FR-2's "factory's own account" check would skip the owner's issues. The token's expiry isn't stated (S8.2). | **Owner decision (Security):** the identity and credential for issue writes. Recommended: a GitHub App installed only on triaged repos. The engine mints a short-lived installation token per call, limited to one repo and `issues: write`. Replies then carry a bot badge, so readers see they are automated. The contents token stays as it is (ADR 0006). Alternative: a second fine-grained token on a dedicated machine account, with `issues: write` only on triaged repos and an expiry of 90 days or less. Either way, never the owner's account, and the self-check in FR-2 compares numeric ids. State the widening and its reason in section 5 (S8.5). |
| 6 | S1.1, S4.5, S9.4, S2.3 | Medium | No | GitHub responses are external input, and they decide where the token goes next. Pagination follows `Link` URLs taken from the response. A transferred issue or a renamed repo answers with a redirect, so a write can land in another repo, possibly one outside `allowed_repo_owners`. The author and the factory account are named by login in places (FR-2, FR-15). The spec names no allow list of API calls; AC-14 only observes the calls afterwards. | Add an SR. One GitHub client module, with a fixed list of method and path pairs (SR-1), refuses everything else in code. It follows a `Link` or redirect only to `https://api.github.com`, and for writes never. Before each write it checks that the repo id and the issue node id match the snapshot. People are compared by numeric id only. Responses are checked for shape and size. On secondary rate limits it backs off; on any unexpected answer it stops that repo's triage (S5.1). Use built-in `fetch`; a client library such as Octokit would need an S4.1 review first. |
| 7 | S2.1, S5.1 | Medium | No | Time-of-check gaps between the snapshot and later actions. (a) An author can edit the issue after triage, so "We've reproduced this bug" then seems to endorse a claim the factory never saw. (b) An issue can be locked, closed, transferred or turned into a discussion before a reply is posted. (c) The record doesn't say which `main` commit the triager read, so `area` and `ref` are checked against a different commit than the one confirmation runs on. | Add an SR. Before each write the engine fetches the issue again. It writes only if the issue is open, not locked, in the same repo, and its title and body hash still match the snapshot. Otherwise it writes nothing and records why. The record carries the commit the triager read. `area` and `ref` are checked against that commit, and confirmation runs on it. FR-18's red run on the fix's base commit stays as it is. |
| 8 | S2.1, S6.2 | Medium | No | The engine "reads `route.json` and acts", but `factory/state` isn't protected (ADR 0009). Anyone with push access, or any process holding the contents token, can write a route that starts a fix lane, or a record that changes questions or duplicates. "No role may write `.factory/issues/**`" binds only agent sessions. | Add an SR. The engine acts only on its own engine-side record of the issue state. If it reads files back, they must extend the hash chain it keeps (F-007 SR-17), and files it didn't write file a Security item and stop that issue. |
| 9 | S5.1, S8.1, S6.1 | Medium | No | Spending and inbox floods. The caps are per repo, so a project with N repos allows 20×N issues a day. They limit concurrency, not how many fix lanes start. Twenty confirmed bugs a day queue twenty full stage 5 to 9 runs, and "none are dropped". The spec doesn't say whether re-triage after an answer counts against the cap. Confirmation sessions have no limits in `limits.yaml`. Each `feature_request` and `security_report` files an inbox item. An attacker can file 20 believable fake security reports a day, each a high-priority Security item, and bury a real one. This competes with the owner's own features for the ADR 0012 budget. | **Owner decision (Security):** extra caps, added to H-0110. Recommended defaults, which projects may lower: non-collaborator authors get at most 3 issues triaged a day and 1 fix lane a week each; at most 3 fix lanes start per repo per day; a project gets at most 10 triage inbox items a day, with the rest collected into one daily digest item; re-triage counts against the daily cap; triage work runs after owner-requested features in the budget queue. Over a cap, issues wait in order, so none are dropped (FR-11 holds). Add a `test_engineer_confirmation` block to `limits.yaml`. |
| 10 | S9.2, S3.2, S6.1 | Medium | No | Classifying a security report wrongly does what SR-5 and SR-10 are there to prevent. A crash on crafted input is often a denial-of-service or memory-safety flaw. A reporter may not know that, and the triager can miss it or be steered. "Bug confirmed" is then posted before any gate runs, and a public PR with a reproduction test shows how to trigger the flaw. A first-round question can also ask the reporter to post the exploit details in public. | Add an SR. The confirmation report and Code Review each carry `security_relevant`. If either is true, the lane stops before any reply, label or push, and a Security item is filed. The triager writes no questions about a suspected weakness; the issue goes to `security_report` instead. When an issue becomes `security_report` in a later round, the engine leaves earlier labels and replies as they are, because removing them also signals. Onboarding suggests the owner enable GitHub private vulnerability reporting and add a `SECURITY.md`. |
| 11 | S8.1, S6.3, S2.2 | Medium | No | The fix scope guard (FR-9) can't be checked as written. "security-relevant file (`security-standards.md` S8)" doesn't exist: S8 lists no files. AC-11 leaves that category out. H-0113 makes the guard an orchestrator check "before stage 6", which is a model check, run once. Files that run code during builds and tests aren't listed: package scripts, `setup.py`, `conftest.py`, `Makefile`, `Dockerfile`, test config, vendored code. Nor are binary fixtures or symlinks. | Add to FR-9 and H-0113. The guard is engine code over the diff, at the end of every session in the lane, the confirmation session included. It uses fixed lists: dependency manifests and lockfiles for each ecosystem; vendored folders; build, test and CI configuration and scripts; the change-controlled and Role-policy deny globs; `interface-contracts.md`; and a per-repo `security_paths` list in the manifest. Any binary file, symlink, or file over the commit caps also stops the lane. Extend AC-11 to cover each list. |
| 12 | S6.1, S1.2, S9.3 | Medium | No | Model text written from the issue also reaches the owner. Inbox items ("Start an interview for this?", "Couldn't reproduce issue #N" "with what was tried") carry the triager's or the test engineer's words. A crafted issue can phrase these to sway the owner's approval ("the owner already agreed to this in chat") (ASI09). Rendered as Markdown, the text can also load tracking images (F-007 #21). FR-10 hands the snapshot to the requirements analyst through "F-009 reference mode", and no F-009 spec exists. The analyst reads project files and has `research_web`, so issue text could steer its search queries and carry project data out. | Add an SR. Inbox items from triage put engine fields first (issue link, kind, route, the reporter's association, `instructions_found`). Model text follows as escaped plain text under a fixed "written from an outside issue" heading. FR-10 waits until F-009 has passed its own Security and Testability Review. Until then, an interview is seeded with the issue link only. |
| 13 | S3.1, S3.3, S5.1 | Medium | No | Secrets: FR-3 scans the snapshot, but several paths are not covered. The spec doesn't say the triager gets the redacted snapshot. The triager reads the repo, where a secret in an unlisted file can be copied into the record, then into the fix spec (committed) or a question (posted). Rendered replies, triage records and the generated fix spec aren't scanned. The spec doesn't say what happens if the scan itself fails. The Security item for a found secret doesn't say the secret is still public on the issue. | Add an SR. The triager gets only the redacted snapshot. The secrets scan also runs on each triage record, each rendered reply and each generated fix spec. A hit drops that output and files a Security item. If the scan can't run, nothing is stored, triaged or posted. The Security item says the secret is still visible on the issue and must be rotated by whoever owns it. The factory doesn't reply about it. |
| 14 | S8.1, S9.4, S2.2 | Medium | No | The confirmation session is not specified as a session. Its tools, write paths, network and limits aren't stated. It gets the test engineer's project policy, which usually allows package registries. Record fields can hold URLs and attachment links. "Fails for the stated reason" is the model's own claim. | Add an SR. Confirmation runs with no network, using dependencies from the cache volumes only; anything else counts as not confirmed. It may write only the new test file and its fixtures. No session fetches a URL or attachment named in an issue or a record (S9.4). The engine checks that the confirmation diff is only that test, that the test was collected and ran, and that the failing test id is the new test. A collection error, import error or timeout does not confirm. |
| 15 | S2.3, S2.1 | Low | No | Labels are shared with people. Anyone with triage access to the repo can change them. "Owner changes a label by hand" stops the factory, but the spec doesn't say how the engine knows the owner did it. If labels were ever read back as state, a collaborator could fake a confirmation. | Add an SR. Issue state comes only from the engine's own record (#8), never from labels. "Owner changed a label" means an event whose actor's numeric id is `owner.github_id`. Labels the engine creates use a fixed color and description. |
| 16 | S9.2, S6.3, S2.2 | Low | No | The S9.2 exemption covers the approved templates, but a project can override them (FR-16). An override could add slots, links or more text. Also, `repos[].issues.enabled` widens what the factory does in public, but it isn't one of the pinned security keys (F-007 SR-5). Finally, the owner has no quick way to stop issue writes on their own. | Add an SR. The engine accepts an override only with the same slots and no links or mentions in its fixed text, under a length cap, and only after its hygiene item is approved with a signed commit. Add `repos[].issues.enabled` to the pinned keys. Add an engine command, `issues.pause`, that stops all GitHub issue writes at once while triage carries on locally. |
| 17 | S1.1, S6.1 | Low | No | `duplicate_of` can only come from numbers in the issue text, because the triager can't see other issues. The reporter therefore picks it, and can tie their issue to someone else's, or to a security report. FR-12's lane-stop "links to" the first PR, but the spec doesn't say where that link is posted. | Add an SR. `duplicate_of` is accepted only if that issue has its own engine record, is open, and isn't a `security_report`. Otherwise the record is treated as `unclear`. The duplicate route posts nothing that names the other issue. The lane-stop link is recorded, not posted. |
| 18 | S9.6, S3.3 | Low | No | `actions.jsonl` has no agent, no target (repo and issue), and nothing that identifies the posted text. S9.6 asks for agent, action, target, time and approval id. | Add `agent: engine`, the repo id, the issue number and the SHA-256 of the rendered body to each line. A dropped question is logged with its reason and hash, never its text (#3). |

**Already covered by the spec or earlier decisions:** Only the triager reads
issue text, in its own container with no network, no write and one tool
(FR-4, SR-2, AC-5). The record has a schema, with unknown keys refused and
control and bidi characters refused (H-0111). Routing is engine code
(FR-6). The engine posts from fixed templates and never closes, edits,
assigns or locks (FR-12, FR-14). No public reply or label on a
`security_report` (SR-10). The snapshot is secret-scanned (FR-3). Reply
loops and the factory's own comments are ignored. The owner merges (ADR
0006). Project limits may only lower the defaults, and the check interval
may only rise (H-0110). Red, green and regression evidence is required for
every fix (FR-18). Session limits for the triager are set (H-0110).

**Comments on the drafted SRs:**
- **SR-1:** list the exact calls: list issues; get one issue; list
  comments on one `needs_info` issue; list issue events (for #15); create a
  comment; add and remove labels on an issue; create a label. Nothing else
  (#6).
- **SR-2:** add that the triager gets the redacted snapshot (#13), and that
  a record with flagged instructions doesn't reach the fix lane (#1).
- **SR-3:** checking the shape and length of the text doesn't make it safe
  for sessions that write code (#1).
- **SR-4:** extend the scan to records, replies and fix specs, and fail
  closed (#13).
- **SR-5:** add the `security_relevant` stop (#10).
- **SR-6:** needs concrete lists, checked by engine code (#11).
- **SR-7:** add #9's caps.
- **SR-8:** add the repo id, the issue number, the approval id and a hash
  of the posted text (#18).
- **SR-9:** add Markdown escaping of the question slot (#4).
- **SR-10:** also keep the record off any public branch (#3).
- **SR-11:** not enough as written; see #4.

**Abuse cases to add to edge cases:** A "minimal example" that is
exfiltration code and runs in CI (#1). An issue citing a real spec line to
get a check removed (#2). A security report deleted by the owner but still
on `factory/state` (#3). A dropped phishing question still published in the
log (#3). A question with `example．com`, `example dot com`, a phone number
or a commit hash (#4). Triage on one repo granting issue writes on all
repos (#5). A transferred issue redirecting a write to another repo (#6).
An issue edited after "Bug confirmed" (#7). A forged `route.json` (#8).
Twenty fake security reports a day, or many repos each at their cap (#9). A
crash report that is really a denial-of-service flaw (#10). A fix that
edits `conftest.py` or a package script (#11). An inbox summary phrased to
win approval (#12). A secret in a repo file copied into a question (#13). A
reproduction that needs an attachment URL (#14). A collaborator changing
labels (#15). A template override with a new slot (#16). `duplicate_of`
pointing at a security report (#17).

**Proposed security requirements for section 9:**

| Id | Requirement | From |
|---|---|---|
| SR-12 | Confirmation and fix branches stay local until Code Review and validation pass, and the PR opens as a draft. The fix lane is refused on a repo whose workflows give secrets to runs for factory branches. `instructions_found` routes to Security, not to the fix lane. Record text reaches code-writing sessions only as fenced data. Reproduction tests don't spawn processes, read the environment, use the network or run decoded code (subject to the owner's decision). | #1 |
| SR-13 | The test engineer derives the expected output from the cited evidence. A crash fix changes only the crash. Code Review stops a fix that loosens a check. The PR body carries a fixed banner. | #2 |
| SR-14 | Snapshots, records and drop logs live in a private, owner-only store. `factory/state` holds only hashes, kinds, routes, ids and the action log. Security-report material stays private (subject to the owner's decision). Sensitive data is listed. | #3 |
| SR-15 | Question checks run on an NFKC-and-confusables fold, with drops for digit and hex runs, spelled-out domains, GitHub autolink forms, mixed scripts, verbatim overlap with the issue, a fixed word list and a profanity list. Questions start with a fixed interrogative. The question is Markdown-escaped. The rendered reply is secret-scanned. Questions are labelled as automated, and a per-repo switch turns them off. | #4 |
| SR-16 | Issue writes use an issues-only credential on triaged repos, never the owner's account, with short-lived or expiring tokens (subject to the owner's decision). | #5 |
| SR-17 | One GitHub client with a fixed list of calls. It follows links and redirects only to `api.github.com`, and on writes never. Repo and issue ids are checked before each write. Ids are compared as numbers. Responses are validated. Unexpected answers fail closed. | #6 |
| SR-18 | Before each write the issue is fetched again and must be open, unlocked, in the same repo and unchanged since the snapshot. The record names the commit the triager read. | #7 |
| SR-19 | The engine acts only on its own record or on files that extend its hash chain. Foreign files file a Security item. | #8 |
| SR-20 | Per-author, fix-lanes-per-day and per-project inbox caps, with a daily digest. Re-triage counts against the daily cap. Confirmation sessions have limits. Triage work runs after the owner's own features (subject to the owner's decision). | #9 |
| SR-21 | A `security_relevant` flag from confirmation or Code Review stops the lane before any public action. The triager asks no questions about a suspected weakness. | #10 |
| SR-22 | The fix scope guard is engine code with fixed path lists, a per-repo `security_paths` list, and binary and symlink stops, run after every session in the lane. | #11 |
| SR-23 | Triage inbox items show engine fields first and model text as escaped, labelled plain text. Interview seeding waits for F-009's Security and Testability Review. | #12 |
| SR-24 | The triager sees the redacted snapshot. Records, replies and fix specs are secret-scanned. A scan that can't run stops everything. | #13 |
| SR-25 | Confirmation has no network, writes only its test, fetches nothing named in an issue, and must fail on the new test itself. | #14 |
| SR-26 | Issue state never comes from labels. Owner label changes are matched by numeric id. | #15 |
| SR-27 | Template overrides are checked and need a signed approval. `issues.enabled` is a pinned key. An `issues.pause` command stops issue writes at once. | #16 |
| SR-28 | `duplicate_of` must name an open issue the engine has triaged that isn't a security report. Duplicates post nothing about the other issue. | #17 |
| SR-29 | The action log adds agent, repo id, issue number and a body hash. Dropped text is never logged. | #18 |

**Permissions this feature adds (S8.5):** `issues: write` on triaged repos
(#5). A new role, `issue-triager`, which reads the repo and has one tool. A
new test engineer session that writes a test from outside input and runs
it (#14). The engine reads issues, comments and events, and posts comments
and labels publicly. Each of these should be stated in section 5 with its
reason, along with the GitHub App or second token if the owner chooses it.

**Items needing an owner Security decision:**
- **#1:** How reporter-derived code is kept away from secrets.
  Recommended: no push until Code Review and validation pass, refuse the fix
  lane where CI gives secrets to factory branches, and send flagged records
  to Security.
- **#3:** Where issue material is stored. Recommended: an owner-only store
  outside every repo, with hashes and routes only on `factory/state`.
- **#5:** The identity and credential for issue writes. Recommended: a
  GitHub App on the triaged repos with short-lived tokens per call, never
  the owner's account.
- **#9:** Extra caps. Recommended: per author 3 issues a day and 1 fix
  lane a week, 3 fix-lane starts per repo per day, 10 triage inbox items
  per project per day plus a digest, and re-triage counted against the cap.

**Notes:** Section 7 lists "F-008 Security and Testability Review, for this feature's threat
model". No F-008 spec exists; this report is F-010's Security and Testability Review and holds its
threat model. F-009 has no spec either (#12). No new external library is
named. gitleaks is already reviewed (F-007 Security and Testability Review, review 5). Any GitHub
client library would need an S4.1 review (#6).

**Not applicable:** S6.3 for agents (no agent writes change-controlled
files; H-0110 to H-0114 go through hygiene items). S4.2 to S4.4 (no new
dependency, unless #6's library is chosen).

## Threat model (S9.7)

**System:** Anyone with a GitHub account opens an issue. The engine (on the
host, as the owner's user) polls GitHub with the factory credential. It
snapshots and scans the issue and hands the snapshot to the triager
container. The triager returns one record through `submit_triage`. The
engine routes it. A bug goes to a test engineer container for confirmation,
then the fix lane (developer, test engineer, gates, each in its own
container). The lane pushes a branch and opens a PR, and the repo's CI runs.
The owner reviews and merges. The engine also posts replies and labels on
the issue, files inbox items for the owner and, later, seeds an interview
for the analyst (F-009).

**Trust boundaries:** issue author ↔ engine (GitHub API); engine ↔ triager
container (snapshot message, `submit_triage`); triager record ↔ the
sessions that write code (the boundary #1 is about); engine ↔ public issue
(replies, labels); engine ↔ `factory/state` (anyone with push access);
pushed branch ↔ the repo's CI and its secrets; inbox ↔ owner.

### STRIDE

| Threat | Example in F-010 | Covered by |
|---|---|---|
| **Spoofing** | Reporter claims in the text to be the owner or a maintainer | Routes ignore claimed identity (OQ-4); #12 shows the association from GitHub |
| | Replies posted under the owner's own account | #5 |
| | A collaborator's label change taken as the owner's | #15 |
| | Self-check or author check done by login | #6 |
| **Tampering** | Forged `route.json` or record on `factory/state` | #8 |
| | Issue edited after the snapshot, before a reply | #7 |
| | Fix that loosens a check, on a misstated `expected` | #2 |
| | Fix that edits build or test scripts | #11 |
| | Template override with new slots | #16 |
| **Repudiation** | No record of which text the factory posted, or why a question was dropped | #18; H-0111 `actions.jsonl` |
| **Information disclosure** | Vulnerability detail re-published on a public `factory/state` | #3 |
| | Security bug fixed in a public PR | #10 |
| | Repo secrets copied into a question or fix spec | #13 |
| | CI secrets read by reporter-supplied test code | #1 |
| | Token sent to a host from a `Link` header | #6 |
| | Project data in analyst search queries steered by issue text | #12 |
| **Denial of service** | Issue floods across repos; fake security reports burying real ones; endless fix-lane queue | #9; FR-11 |
| | Factory account suspended for abusive posts | #4 |
| **Elevation of privilege** | Outside reporter's code runs in CI with secrets, or on the owner's machine | #1 |
| | Outside reporter changes product behaviour without an owner decision | #2 (OQ-1 evidence rule) |
| | Issue writes on repos where triage is off | #5 |
| | Write redirected to a transferred issue in another repo | #6, #7 |

### OWASP Top 10 for Agentic Applications

| Risk | Where it applies | Covered by |
|---|---|---|
| ASI01 Agent goal hijack (prompt injection) | Issue text and answers to the triager; record text to the test engineer and developer; snapshot to the analyst | SR-2, H-0111; #1, #2, #12 |
| ASI02 Tool misuse | `submit_triage` used to choose public text (questions) or duplicates; the reproduction test as a code runner | FR-17; #4, #17, #1 |
| ASI03 Identity and privilege abuse | The factory credential posting publicly; owner identity on replies | H-0114; #5, #15 |
| ASI04 Agentic supply chain | Reporter "minimal examples" committed as tests; fixes touching dependencies or build scripts | #1, #11 |
| ASI05 Unexpected code execution | Reproduction code running in CI or on the owner's machine | #1, #14 |
| ASI06 Memory and context poisoning | Forged records on `factory/state`; issue snapshots seeding interviews | #8, #12 |
| ASI07 Insecure inter-agent communication | Triager → engine → test engineer, with free text crossing the boundary | H-0111 schema; #1 (fenced data), #14 |
| ASI08 Cascading failures | A misclassified security bug becoming a public PR; account suspension stopping all writes | #10, #4 |
| ASI09 Human-agent trust exploitation | Persuasive inbox summaries; rubber-stamped "all gates passed" PRs | #12, #2 (PR banner), #9 (digest) |
| ASI10 Rogue agents | Triager or fix sessions acting beyond their role | FR-4, container per session (ADR 0015); #11, #14 |
