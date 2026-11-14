# Decision management

The owner works through one inbox of GitHub issues, in VS Code or on the phone (F-011, ADR 0022). Agents fill it; the
owner acts on it. Each item is labeled by its kind. Sections 1 to 3 describe
the Decision, Testing and Hygiene kinds; "One inbox" below lists every kind
and its actions.

## 1. Decision inbox

Categories (only these five; adding one needs the owner's agreement):

| Category | For |
|---|---|
| Product | What the software does |
| Architecture | How it is built: patterns, data structures, boundaries, data flow, components, libraries |
| Interfaces | Signatures, types, APIs, request/response formats, compatibility, contract versions |
| Assumptions | Unclear requirements and the assumption proposed to fill them |
| Security | Security concerns needing the owner's call |

Architecture and Interfaces stay separate: "use a queue between A and B" is
Architecture; "the message on that queue has fields x, y, z" is Interfaces.

**Every decision card has:** title, category, priority, status, blocking
yes/no, context, options, pros and cons of each, project impact, the agent's
recommendation, and the cost of delay.

**Actions:** Approve, Reject, Request changes, Ask for more research, Defer.

**Defer** keeps the card in the queue, lowers its effective priority, keeps its
blocking flag, and can be undone. Deferring is never approval.

Approved Architecture decisions become ADRs (`adr/`). Approved Interfaces
decisions update `interface-contracts.md`.

## 2. Testing inbox

Only problems the orchestrator could not resolve. Routine failures it fixes are
not shown. Each item has: feature, failed test or stage, expected vs actual,
logs, agent transcripts, root-cause analysis, recovery attempts made, and a
recommended next step. Root cause is classified as one of: test code, product
code, environment, dependency, infrastructure, or incomplete run.

## 3. Configuration hygiene inbox

Every proposed change to a change-controlled file (see `CLAUDE.md`). No change
is applied before approval, however small. Each item has:

1. File.
2. Reason.
3. Current content.
4. Proposed content.
5. Full diff.
6. Expected benefit.
7. Risks and side effects.
8. Recommendation.

On approval the change is committed on its own, with the item's id in the
commit message, so it can be traced and reverted.

## One inbox (F-011)

Every item is a GitHub issue in the project's private config repo (ADR 0022,
Inbox item v3.0), assigned to the owner and labelled `factory-inbox` and by
kind; decisions also carry their category. The owner sees them in VS Code
through Microsoft's GitHub Pull Requests extension and on the phone through
GitHub Mobile, and acts with a 👍 on an action comment or a command comment.
Pull requests are not items: the owner merges them in GitHub's PR view
(F-011 OQ-12). At Rapid prototype Claude merges a PR once the owner has
approved its content through the items above (ADR 0030).

| Kind | Owner actions | Confirmation step |
|---|---|---|
| Decision | Choose an option, Reject, Request changes, Ask for more research, Defer, Restore priority | On a Security decision: 🚀 or `/confirm <code>` |
| Hygiene | Approve, Reject, Request changes, Defer | On Approve |
| Testing | The recommended next step or another listed step, Ask for more research, Defer | No |
| Spec sign-off | Approve, Request changes, Defer | On Approve |
| Maturity | Approve, Reject, Defer | On Approve |
| Notice | Dismiss | No |

A PR merge is confirmed by GitHub's own merge dialog (F-011 A-3).

## Item lifecycle

```
Open ──► Approved ─► (applied / recorded)
  │  ──► Rejected
  │  ──► Changes requested ─► Open (revised)
  │  ──► Research requested ─► Open (revised)
  └──► Deferred ─► (restore) ─► Open
```

Where items are stored and their exact schema are open decisions 3 and 2.
