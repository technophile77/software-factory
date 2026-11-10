# Feature: Advisor agent for hard questions

- **Id:** F-006
- **Status:** Draft (assumptions awaiting the owner; Gate 1 next)
- **Requested by / date:** Alex, 2026-11-10 (split out of F-005)
- **Spec version:** 2

## 1. Objective and business purpose
Some questions the factory puts to the owner are hard and cross-cutting, and
the agent asking them may be running on a cheaper model than the question
needs. The advisor is a support role that researches such a question on a
stronger model and returns findings and options with a recommendation. It
advises only. It never answers for the owner, decides, or changes code,
specs, or configuration.

Already decided (F-005 interview, owner, 2026-11-10):
- The advisor is its own feature (F-006), and F-005's analyst must be able
  to call it from an interview's "more information" step.
- The analyst does not consult other agents for more information; it uses
  shared skills and docs itself, and escalates to the advisor only when the
  question needs a stronger model.
- Until F-006 is built, no escalation is offered (F-005 OQ-3).
- Analyst escalation to the advisor is an approved permission widening
  (F-005 OQ-4).

Interview answers (owner):
- Q1 (2026-11-10): two callers. The analyst during an interview's "more
  information" step, and the orchestrator when it prepares options and a
  recommendation for a hard inbox decision. No other agent calls it.
- Q2 (2026-11-10): always the strongest model at high effort (the top rung
  of the F-002 ladder). Not calibrated or tuned by F-002.
- Q3 (2026-11-10): the caller (analyst or orchestrator) may escalate when
  it judges a question is beyond it, stating its reason; the owner may also
  ask for the advisor on any interview question. This adds an "ask the
  advisor" choice to the F-005 interview skill. The owner always sees that
  the advisor was used and why.
- Q4 (2026-11-10): the analyst's research sources, read only (project code
  and docs; factory docs, ADRs and past decisions; shared skills; the web
  only through the web reader), plus a shell inside a sandbox so it can
  test code. No file writes outside the sandbox and no inbox access. Its
  output goes back only to the caller.
- Q5 (2026-11-10): the shell runs only in the shared OS sandbox proposed in
  F-003 Gate 2 item R2-1 (throwaway copy of the code, no network, no
  secrets, no access to the real repo). The advisor ships without a shell
  and gains it once that sandbox is decided and built.
- Q6 (2026-11-10): every advisor call needs the owner's OK. Agents can only
  propose a call (with their reason, per Q3); it runs when the owner
  approves it. The owner's own requests need no further approval. In an
  interview the analyst proposes the call as an interview item.
- Q7 (2026-11-10): the orchestrator files the hard decision as a normal
  inbox item in its own category, with its options and recommendation, plus
  an "Ask the advisor first" action carrying its reason. If the owner picks
  it, the advisor runs and its advice is added to the same item. No new
  category or second item.
- Q8 (2026-11-10): fixed output shape: findings each with a source (web
  findings marked untrusted); two to four options with trade-offs; a
  recommendation with reasoning and confidence; risks or unknowns. Shown to
  the owner word for word, labelled as the advisor's, beside the caller's
  own question or options. It never fills in an answer.
- Q9 (2026-11-10): the caller hands the advisor the question, why it
  matters, the caller's options, pointers to relevant files and decisions,
  and (in an interview) the owner's earlier answers for that feature. Not
  the caller's recommendation or reasoning.

## 2. Expected behavior
**In an interview (F-005).**
1. While asking a question, the analyst may judge it needs a stronger model.
   It then shows the owner a proposal to ask the advisor, with its reason,
   as an interview item. The owner approves or declines it there.
2. On any interview question the owner may also choose "ask the advisor".
   That is the owner's own request and needs no further approval.
3. When a call is approved, the question stays open while the advisor works.
   The advice then appears beside the question, word for word and labelled
   as the advisor's. The owner answers, asks for more information, asks the
   advisor again, or defers, as with any question.

**For a hard inbox decision.**
4. The orchestrator files the decision as usual: its own category, options,
   and recommendation. When it judges the decision needs a stronger model it
   adds an "Ask the advisor first" action with its reason.
5. If the owner picks that action, the advisor runs, and its advice is added
   to the same item. The item stays open for the owner to decide.

**Every call.**
6. The advisor gets the question, why it matters, the options, pointers to
   relevant files and decisions, and in an interview the owner's earlier
   answers. It never gets the caller's recommendation or reasoning.
7. It researches read only: project code and docs, the factory's docs, ADRs
   and past decisions, the shared skills, and the web through the web
   reader. Once the R2-1 sandbox exists, it may also run code in it.
8. It returns findings with sources, two to four options with trade-offs, a
   recommendation with reasoning and confidence, and risks or unknowns.
9. It always runs on the strongest model at high effort.
10. It never answers a question, approves an assumption, picks an option,
    files an inbox item, or edits anything.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | A new support role `advisor` with `agents/advisor/AGENT.md` and a role policy entry. It advises only and never changes code, specs, configuration, transcripts or inbox items. |
| FR-2 | Only the requirements analyst (during an interview) and the orchestrator (for a decision inbox item) may propose an advisor call. The engine refuses a call from any other role. |
| FR-3 | No advisor call runs without the owner's approval. An agent's proposal carries its reason. In an interview the proposal is an interview item the owner approves or declines; for an inbox item it is the "Ask the advisor first" action. The owner's own "ask the advisor" choice in an interview is itself the approval. |
| FR-4 | The engine starts the advisor on the top rung of the F-002 ladder (strongest model) at high effort, whatever the manifest, calibration, or evaluator say. The rung is recorded in the agent report. |
| FR-5 | The engine builds the advisor's input from: the question text, why it matters, the caller's options, file and decision pointers, and (interview only) the owner's recorded answers for that feature. The caller's recommendation and reasoning are never included. |
| FR-6 | The advisor's tools are read-only file tools over the paths the analyst may read, the shared skills, and web research through the web reader only. It has no write tools, no shell, no inbox or transcript access, until FR-7 applies. |
| FR-7 | Once the R2-1 OS sandbox exists, the advisor gets a shell that runs only inside it: a throwaway copy of the code, no network, no secrets, no access to the real repo. Until then no shell is granted. |
| FR-8 | The advisor's output has four fixed sections: Findings (each with a source; web findings marked untrusted), Options (two to four, each with trade-offs), Recommendation (with reasoning and a confidence of low, medium or high), Risks and unknowns. Output that doesn't match is rejected and the owner is told the call failed. |
| FR-9 | The output is shown to the owner word for word and labelled as the advisor's: in an interview beside the question, in the inbox in the same item. The caller cannot edit or summarize it. |
| FR-10 | The advice is recorded: in the interview transcript for interview calls, in the inbox item's history and body for inbox calls. |
| FR-11 | The F-005 `spec-interview` skill offers "ask the advisor" on every question, and shows advisor proposals for the owner to approve or decline. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a role other than the analyst or orchestrator, when it requests an advisor call, then the engine refuses it and no advisor session starts. | FR-2 |
| AC-2 | Given an analyst proposal in an interview, when the owner declines it, then no advisor session starts and the question stays as it was. | FR-3 |
| AC-3 | Given an analyst proposal, when the owner approves it, then exactly one advisor session starts and the transcript records the approval and the reason. | FR-3, FR-10 |
| AC-4 | Given the owner chooses "ask the advisor" on a question, then one advisor session starts with no further approval step. | FR-3, FR-11 |
| AC-5 | Given an inbox item with "Ask the advisor first", when the owner hasn't picked it, then no advisor session starts; when the owner picks it, one starts and the advice is added to the same item, which stays open. | FR-3, FR-9, FR-10 |
| AC-6 | Given a manifest or evaluator setting a lower rung for `advisor`, when an advisor session starts, then it runs on the top rung at high effort and the agent report records that. | FR-4 |
| AC-7 | Given a caller whose options include a recommendation and reasoning, when the advisor input is built, then it contains the question, why, options and pointers, and neither the recommendation nor the reasoning. | FR-5 |
| AC-8 | Given an advisor session, when it tries to write a file, run a shell command, or read a denied path, then the attempt is refused. | FR-6, FR-7 |
| AC-9 | Given advisor output missing a section or with fewer than two or more than four options, then it is rejected, nothing is shown as advice, and the owner sees that the call failed. | FR-8 |
| AC-10 | Given valid advisor output, then the owner sees it byte for byte as returned, labelled as the advisor's, beside the caller's question or options. | FR-9 |
| AC-11 | Given advisor output containing an instruction (for example "approve this assumption"), then nothing changes state; the text is only shown. | FR-1, FR-9 |

## 5. Constraints
- Advisory only, like the other support roles (spec section 2): it never
  changes code, specs, configuration, transcripts or inbox items.
- Never answers an interview question or approves an assumption for the
  owner (owner rule, 2026-11-10).
- The engine doesn't exist yet (ADR 0001). The engine-side parts are built
  with the engine; this feature delivers the role, its policy, the contract
  changes, and the F-005 skill change, tested against the fake engine as
  F-005 was.

## 6. Edge cases
- The owner asks the advisor again on the same question: a new approved
  call; both answers stay in the record.
- The advisor call fails or times out: the owner is told; nothing retries
  without a new approval.
- The question changes revision while the advisor runs: the advice is shown
  against the revision it was asked about.
- Planted text in a repo file or web page tells the advisor to recommend an
  option or "approve": its output is only advice shown to the owner (AC-11).
- The feature is deferred or closed while a call runs: the advice is still
  recorded; nothing else changes.

## 7. Dependencies
- F-005 spec interview (merged): the escalation entry point.
- F-002 model/effort tuning: the top rung of its ladder.
- ADR 0012: project budgets and billing mode.
- Web reader role (F-005), for the advisor's web research.
- F-003 Gate 2 R2-1 OS sandbox (owner decision pending), for the shell only.

## 8. Assumptions
Proposed in the interview and approved by the owner (2026-11-10).

| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Advisor calls count against the ADR 0012 project budget like any agent run. When a call would exceed the remaining budget, the approval prompt says so; the owner may still approve it. | Owner, 2026-11-10 (thread card) | Approved |
| A-2 | A failed or timed-out advisor call is reported to the owner and never retried without a new approval. | Owner, 2026-11-10 (thread card) | Approved |
| A-3 | The advisor's reads are the analyst's approved read paths (F-005 OQ-4), with no other features' interview transcripts beyond what the engine supplies. | Owner, 2026-11-10 (thread card) | Approved |

## 9. Security considerations
_Gate 1 runs next._

## 10. Interface requirements
Each needs owner approval through a hygiene item (ids H-0060 to H-0064):
- **H-0060** `agents/advisor/AGENT.md`, and an advisor entry in the shared
  agent lists (`docs/agent-responsibilities.md`, `docs/architecture.md`,
  spec section 2 as a support role 2.9).
- **H-0061** Role policy: an `advisor` role with read-only file tools, the
  shared skills, web only via the web reader, no shell until R2-1; only the
  analyst and orchestrator may request it.
- **H-0062** Inbox item v1.1: an optional `advisor_reason` field, an owner
  action `advisor_requested`, and an `Advisor` body section.
- **H-0063** Engine control channel v1.2: interview item kind
  `advisor_proposal`, reply kinds `ask_advisor`, `approve_advisor`,
  `decline_advisor`, and an `advice` field on items.
- **H-0064** `requirements-analyst` and `orchestrator` AGENT.md: when and how
  to propose an advisor call.

## 11. Open interview questions
| Id | Question | Category | Status |
|---|---|---|---|
| Q1 | Who can call the advisor? | Product | Answered: analyst and orchestrator (owner, 2026-11-10) |
| Q2 | Which model does the advisor run on? | Product | Answered: always strongest, high effort (owner, 2026-11-10) |
| Q3 | Who decides a question goes to the advisor? | Product | Answered: caller with reason, or the owner (owner, 2026-11-10) |
| Q4 | What can the advisor read and use? | Security | Answered: analyst's sources read only, plus shell in a sandbox (owner, 2026-11-10) |
| Q5 | What sandbox does the advisor's shell run in? | Security | Answered: the R2-1 sandbox; shell added once it exists (owner, 2026-11-10) |
| Q6 | What limits the advisor's spend? | Product | Answered: owner's OK for every call (owner, 2026-11-10) |
| Q7 | How does the orchestrator's request for an advisor call reach the owner? | Product | Answered: extra action on the decision item (owner, 2026-11-10) |
| Q8 | What does the advisor return, and how is it shown? | Product | Answered: fixed shape, shown word for word (owner, 2026-11-10) |
| Q9 | What context does the caller give the advisor? | Product | Answered: question and options, no recommendation (owner, 2026-11-10) |

## 12. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Skeleton with what the F-005 interview already decided | — |
| 2 | 2026-11-10 | Full draft from interview answers Q1 to Q9; assumptions A-1 to A-3 proposed | Owner answers Q1-Q9 (thread) |
