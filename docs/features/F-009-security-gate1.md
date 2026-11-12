# F-009 Security Gate 1 (requirements review)

- **Feature:** F-009 Start an interview from an existing document, spec v2
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-12
- **Maturity level:** Rapid prototype. Only Critical findings block there.
- **Result:** 9 findings: 0 Critical, 3 High, 4 Medium, 2 Low. **Nothing
  blocks at Rapid prototype.** The High findings would block at Alpha, so
  they should become requirements now, before anything is built. One needs
  an owner decision (Security): #3.

| # | Criterion | Severity if missed | Finding | Suggested resolution |
|---|---|---|---|---|
| 1 | S1.4, S8.4 | High (does not block) | The client script opens a path the owner names. SR-4 covers symlinks and devices, but not two cases. On Windows, a UNC path (`\\host\share\doc.md`) or a device path (`\\?\`, `\\.\`) makes the script open a remote file over SMB and send the owner's NTLM credentials. The same problem was F-005 Gate 1 #2. A FIFO or special file can also block the read forever. And SR-4 checks the path before opening it, which leaves a window where the file can be swapped. | Extend SR-4. Refuse UNC and device paths and anything that isn't a local drive or absolute POSIX path. Open with `O_NOFOLLOW` where the OS has it, then `fstat` the open handle: it must be a regular file within the size limit. Read at most limit + 1 bytes. Add ACs for a UNC path, a FIFO, and a symlink swapped in after the check. |
| 2 | S2.1, S6.1, S6.2 | High (does not block) | With "My requirements", document statements count as the owner's answers, and the only check is the source confirmation item. The analyst writes that item. A document with injected text, or an analyst that makes a mistake, can put a line in the spec that cites the document but doesn't match it, or leave one out of the list. The owner would then confirm text they never wrote. This is the same gap that F-005 Gate 1 #9 closed for assumptions. | Add an SR. Every spec line drawn from the document carries a quote of its source text. The readiness check, run by the engine, refuses unless each quote is found word for word in the stored document (by its recorded hash). The confirmation item lists exactly the spec lines that carry a quote, and the engine builds the list, not the analyst. Add an AC: a spec line citing a quote that isn't in the document fails the readiness check. |
| 3 | S6.1 | High (does not block) | Markdown can hide text from the owner that the analyst still reads: HTML comments, `<details>` or raw HTML, link reference definitions, zero-width and bidi characters. The owner sees the document in a renderer, but the analyst reads the raw text. Hidden instructions or requirements would then come into the interview under the owner's name. The web reader strips this kind of content (F-007 SR-21), but this new input path doesn't. | **Owner decision (Security).** Options: (a) The engine refuses a document that contains HTML comments, raw HTML, or zero-width or bidi characters, and the owner removes them and retries. (b) The engine strips them and lists what it removed in the transcript and in the first interview item. (c) It keeps them, and the analyst flags each one as a question. Recommended: (a). It is the simplest rule to test, and a requirements document rarely needs any of these. |
| 4 | S1.1, S2.1 | Medium (does not block) | FR-1 and FR-2 describe the checks the client makes. The engine is the server, and nothing in the spec has it repeat them. It also has to check that the text is valid UTF-8 with no NUL bytes, that `media_type` and `provenance` are among the allowed values, and that the size is within the limit. Its 1 MiB message cap can be hit before the 256 KiB text limit when JSON escapes control characters. | Add an SR. The engine validates every `document` field itself and fails closed. It refuses control characters other than tab, LF and CR, which also keeps the escaped size under the message cap. Add ACs that send bad values straight to the channel, bypassing the client. |
| 5 | S1.4 | Medium (does not block) | `document.name` comes from the client. If the engine uses it in a path or a commit message, a name like `../../x` or one containing newlines becomes a path or log injection. | The stored file name is fixed by the engine (`F-nnn-source.md` or `.txt`, from `media_type`). `name` is display text only: limited in length, control characters stripped, never part of a path or a git argument. |
| 6 | S3.2, S3.1 | Medium (does not block) | The spec doesn't name the sensitive data (S3.2). The document is committed to the project's config repo, pushed to GitHub, and sent to the model API, and it stays in git history. gitleaks finds credentials, but not personal data, customer details or confidential plans. FR-3 says the refusal "says which line", but it must not echo the matched value. | Add to section 9: the sensitive data is the whole document, which goes to the config repo remote and the model provider. The skill tells the owner this before they choose a file, as it already does for secrets. A refusal names the line number and rule only. |
| 7 | S9.4 | Medium (does not block) | Starting from a document puts much more project text in the analyst's context. The analyst's research requests to the web reader may carry document text, beyond the question's topic. Today that limit is only a rule the model follows. | Restate it in the analyst's instructions for this path: a request to the web reader never quotes the document. Log every reader request in the transcript, as now, so the owner can audit. No new control proposed at Rapid prototype. Recorded as a known residual. |
| 8 | S5.1 | Low (does not block) | A 256 KiB document is roughly 65,000 tokens in the analyst's first turn, and again on every resumed session. Repeated starts can use up the project budget quickly. | Count document size against the ADR 0012 budget at the start, and refuse a start that the remaining budget can't cover, with a message. |
| 9 | S2.3, S6.2 | Low (does not block) | `provenance` decides how much the document counts as the owner's answer. Nothing says the skill must take it from the owner, so the model could fill it in. | Skill rule: `provenance` is sent only from the owner's pick in the picker in that turn, like every other reply kind (F-005 SR-10). |

**Already covered by the spec:** the document treated as data with a framed
boundary (SR-1). Claude in the skill never reads it (SR-2). A secrets scan
runs before storage (SR-3, FR-3). Symlinks and devices are refused (SR-4,
extended by #1). The stored document is write-denied to agents (SR-5,
FR-4). The document never overrides security standards, ADRs or approved
interfaces (FR-9, AC-6). Injected instructions are not acted on (AC-7). No
new external library: Markdown and plain text only, no parser (OQ-2).

**Abuse cases to add to edge cases:** a UNC path or a FIFO (#1). Injected
text that becomes a confirmed requirement (#2). Instructions hidden in HTML
comments or zero-width characters (#3). A client that skips the checks (#4).
A path in `name` (#5). A document holding personal data (#6). Document text
leaking through web research (#7). Repeated large starts (#8).

**Permissions this feature adds (S8.5):** the client script reads one file
the owner names, read-only. The analyst reads one more file in its worktree,
which it can already read under `read: **`. Every role is denied writes to
the source file. No new network access, token or tool. Nothing here needs a
Security decision except #3.

**External interactions (S9):** none new. The document goes only where
interview text already goes (config repo remote, model API). So no new
threat model is needed beyond F-007's.

**Not applicable:** S4.1 to S4.4 (no new library or component). S8.2 and
S8.3 (no new credential, no CI change). S6.3 (no change-controlled file is
written at run time; the AGENT.md, skill, contract and policy edits go
through H-0105 to H-0108).
