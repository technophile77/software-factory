# Proposal 0022: Say "one inbox" where docs still say "three inboxes"

- **Raised:** 2026-11-13, by the owner (decision card: "Draft H-0140 now").
- **Category:** none needed. This is a Configuration hygiene item. It only
  brings wording in line with F-011, which the owner already approved. It
  makes no Product, Architecture, Interfaces, Assumptions or Security
  decision.
- **Status:** Open. Approved by merging the PR that carries it.
- **Hygiene item:** H-0140. H-0141 to H-0144 are reserved for follow-ups.

## Proposed change (H-0140)

1. **Files:** `docs/architecture.md`, `docs/decision-management.md`,
   `docs/definition-of-done.md`.
2. **Reason:** F-011 (Approved, merged in PR #35) replaces the three inboxes
   with one queue whose items are labeled by kind. These three docs still
   say there are three inboxes, so they contradict an approved spec, and
   agents read them.
3. **Current content:**
   - `architecture.md`: "with three inboxes: Decisions, Testing, and
     Configuration hygiene", and the diagram box "Inboxes (Decision, Testing,
     Config hygiene)".
   - `decision-management.md`: "The owner works through three inboxes in VS
     Code."
   - `definition-of-done.md` item 11: "All three inboxes have no open blocking
     item for this feature".
4. **Proposed content:** one inbox whose items are labeled by kind, as F-011
   FR-1 and FR-2 describe. See the diff.
5. **Full diff:** below.
6. **Expected benefit:** the docs agree with F-011. An agent checking
   definition-of-done item 11 looks at every item kind (Spec sign-off,
   Pull request, Maturity), not only the old three.
7. **Risks and side effects:** until F-011 is built, the extension still shows
   only Decision items, so the docs describe the approved design ahead of the
   code. `decision-management.md` already says the new kinds take effect when
   F-011 is built.
8. **Recommendation:** approve.

### Left alone on purpose

- `docs/spec/software-factory-spec-v0.1.md` is the owner's baseline and
  still says three inboxes. F-011 is the approved change to it. This item
  doesn't edit the spec.
- ADR 0003 says the extension "presents the three inboxes". ADRs record what
  was decided at the time, so it isn't rewritten.
- Phrases like "Testing inbox" and "Decision inbox" elsewhere still name item
  kinds correctly, because the kinds stay separate item types (F-011 A-1).

### Full diff

```diff
diff --git a/docs/architecture.md b/docs/architecture.md
index 2fdee55..1220d69 100644
--- a/docs/architecture.md
+++ b/docs/architecture.md
@@ -7,8 +7,9 @@ Interface details are still to be decided; see `open-decisions.md`.
 
 These are requirements, not choices:
 
-- The owner's control surface is **VS Code**, with three inboxes: Decisions,
-  Testing, and Configuration hygiene.
+- The owner's control surface is **VS Code**, with one inbox (F-011). Each
+  item is labeled by its kind: Decision (with its category), Hygiene,
+  Testing, Spec sign-off, Pull request, Maturity, or Notice.
 - Code is written through **Claude Code**.
 - There are **six primary agent roles**, three advisory support roles
   (project evaluator, context hygiene, advisor) and a web reader that fetches pages
@@ -23,7 +24,7 @@ These are requirements, not choices:
 ## Components (logical, not yet technical)
 
 ```
- Owner ── VS Code ── Inboxes (Decision, Testing, Config hygiene)
+ Owner ── VS Code ── Inbox (one queue, items labeled by kind)
                          ▲            │ approve / reject / defer ...
                          │            ▼
                   Inbox store  ◄──  Orchestration  ──►  Agents (6 roles)
diff --git a/docs/decision-management.md b/docs/decision-management.md
index 4f63dca..83ce35b 100644
--- a/docs/decision-management.md
+++ b/docs/decision-management.md
@@ -1,7 +1,9 @@
 # Decision management
 
-The owner works through three inboxes in VS Code. Agents fill them; the owner
-acts on them.
+The owner works through one inbox in VS Code (F-011). Agents fill it; the
+owner acts on it. Each item is labeled by its kind. Sections 1 to 3 describe
+the Decision, Testing and Hygiene kinds; "One inbox" below lists every kind
+and its actions.
 
 ## 1. Decision inbox
 
diff --git a/docs/definition-of-done.md b/docs/definition-of-done.md
index d42af27..8e442b7 100644
--- a/docs/definition-of-done.md
+++ b/docs/definition-of-done.md
@@ -15,7 +15,7 @@ request only when every box below is checked, each with the evidence named.
 | 8 | Validation judge issued PASS | Judge report |
 | 9 | Required documentation updated | Listed in the judge report |
 | 10 | Interface contracts compliant | No unapproved diff to `interface-contracts.md`; contract tests pass |
-| 11 | No unresolved blocking issues | All three inboxes have no open blocking item for this feature |
+| 11 | No unresolved blocking issues | The inbox has no open blocking item of any kind for this feature |
 | 12 | CI green on the PR head | Required CI checks for the repo's maturity level pass (ADR 0008) |
 
 The orchestrator opens the PR once items 1 to 11 are met, and marks it ready
```
