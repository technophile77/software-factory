# Proposal 0014: Project control, resumable runs, and token budgets

**Status:** Q1 to Q5, Q7 and Q8 decided by the owner on 2026-11-10 (see
"Owner decisions" at the end); Q6 still open.
Originally proposed for the owner's decision. Raised by the owner on
2026-11-10. Not a decision until the owner chooses; the outcome becomes an
ADR and a feature spec.

## Problem

1. The factory can't be paused for one project. The engine control channel
   has `engine.pause` and `engine.resume` for one feature or all of them.
   That state isn't persisted, and the VS Code extension has no control for
   it.
2. Nothing says what happens when the model token budget runs out mid-run.
   Today an interrupted agent run would simply fail.
3. Nothing stops the engine from launching a session that the remaining
   budget can't finish.
4. Nothing requires the owner's go-ahead before the factory starts work on a
   newly onboarded project. F-003 onboarding starts a test baseline and
   F-002 calibration as soon as the engine runs.
5. The engine doesn't check that the repos it works on are ones the owner
   authorized.
6. The manifest records each repo's current maturity, but not the level the
   owner wants it to reach.
7. Plan usage that resets on a schedule is lost if unused before the reset.
8. Nothing says how a project is paid for: a subscription plan with usage
   windows, or pay-per-token, and whether it may spill over into paid usage.

## What already limits the factory

- It works only on repos listed in a project's `factory-project.yaml`
  (ADR 0010).
- Its GitHub token reaches only repos the owner granted (ADR 0006, S8.2).
  This is the hard boundary: a repo removed from the token can't be touched
  whatever the config says.

## Decisions needed

### Q1. Where per-project pause lives (Architecture, Interfaces)

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Engine state + control methods (recommended)** | New methods `project.pause { project, mode: "safe" \| "now" }`, `project.resume`, `project.list`. State saved in the engine's local state file, so it survives restarts. Extension shows a Factory view with Pause / Resume per project and a status-bar count | Instant; no commit needed; adding methods is non-breaking for the contract | State is local to the machine running the engine |
| B. A `paused: true` key in `factory-project.yaml` | Owner edits the manifest | Visible in Git, shared | Pausing needs a commit to the config repo; slow in an emergency |

Pause semantics, both options: no new agent session starts; running
sessions stop at their next safe point (`safe`), or are interrupted at once
and checkpointed (`now`). The inbox stays usable. Resuming continues from
the checkpoints (Q2).

### Q2. What happens when a run is interrupted (Architecture)

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Checkpoint and resume (recommended)** | Each agent commits to its own branch after each step (ADR 0004/0005 worktrees). The engine records the session id and progress in `.factory/runs/`. An interruption for budget or pause is status `interrupted`, not a failure, and doesn't use a retry. On resume, the engine resumes the same session; if it can't, it restarts only that step from the last commit | No lost work; no feature restarts | More engine state to keep correct |
| B. Restart the interrupted step | Discard the session; rerun the step from its last commit | Simpler | Repeats work and tokens |

### Q3. Token look-ahead (Architecture)

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Estimate, admit, reserve (recommended)** | Before launching a run, the engine estimates its cost: the 90th percentile of past runs for the same agent, stage, and maturity level, from the per-run token records F-002 adds. It launches only if the remaining budget covers that estimate plus a reserve. Otherwise the run waits, and the extension shows "Waiting for budget, resets at …". Budget goes first to features already in progress, and a reserve is held for the security gates and the judge, so features don't stall at the last step. A run that exceeds its estimate by 50% pauses at its next safe point and files a Testing inbox item | Predictable; no half-finished sessions | Early estimates are rough until there's history (use a fixed default per agent until 5 runs exist) |
| B. Hard stop only | Track usage; stop at the limit; rely on Q2 to resume | Simple | Starts sessions that can't finish |

### Q4. Who sets the budget (Product)

**Recommended:** the owner sets daily and weekly token or dollar limits for
the whole factory in master config, and optionally per project under
`settings.budget` in `factory-project.yaml` (an optional key, so
non-breaking). The engine also respects the provider's own rate and usage
limits when it can read them, and uses whichever limit is lower.

### Q5. Authorization safeguards (Security)

**Recommended**, all together:
- **New projects start Paused.** Onboarding prepares everything, but no
  agent session runs until the owner activates the project in the
  extension (Q1). Activation is recorded with who and when.
- **Three-way repo check.** At startup and before every session, the engine
  works on a repo only if it is (a) listed in an activated project's
  `factory-project.yaml`, (b) reachable with the factory token, and (c)
  owned by, or shared with, an account on the owner's allow list in master
  config. A mismatch stops that project and files a Security item. A repo the
  token can reach but no manifest lists is reported, so the token can be
  narrowed (S8.2).
- **Work starts only from the owner.** A feature starts only from the owner's
  request (control channel, or an approved inbox item). Agents can suggest
  work but can't start it. Already true for merges: protected `main` needs
  the owner's review (ADR 0006).

### Q6. Target maturity (Product)

| Option | How |
|---|---|
| **A. `target_maturity` per repo in the manifest (recommended)** | The owner sets the target. The orchestrator plans work toward it (using the onboarding Recommended work list) and proposes the promotion when the evidence is met. `maturity` itself changes only through an approved promotion, so editing it by hand to skip evidence is refused by the engine |
| B. No target; the owner requests each promotion | Simpler; the factory doesn't plan ahead |

Security standards per project need no new mechanism: the manifest's
`standards.security` file can only add rules to the master standards, and
the blocking severities already rise with the maturity level. Changing the
master standards stays a hygiene item.

### Q7. Using budget before a reset (Product)

| Option | How |
|---|---|
| **A. Opt-in "use before reset" (recommended)** | When a plan's usage window is about to reset with budget left, the engine starts queued work that the owner already approved and that its estimate says will finish before the reset: approved features, test baselines, context hygiene reviews. It never starts unapproved work to spend tokens. Off by default; set per project in `settings.budget` |
| B. No | Budget left at a reset is lost |

Pay-as-you-go API billing doesn't reset, so this only applies to plan
limits.

### Q8. Billing mode and overflow (Product)

**Recommended:** each project declares its billing mode under
`settings.budget` in `factory-project.yaml` (master config gives the
default):

```yaml
settings:
  budget:
    mode: subscription        # subscription | tokens
    # subscription: a plan such as Claude Max. Limits are usage windows that
    # reset; the look-ahead (Q3) plans against the time left in the window.
    # tokens: pay per token (API). Limits are dollar caps; nothing resets.
    caps: { daily_usd: 20, weekly_usd: 100, monthly_usd: 300 }   # tokens mode
    overflow:
      enabled: false          # off by default
      source: credits         # credits (purchased usage) | api_key
      max_usd: 50             # per month; required when enabled
    use_before_reset: false   # Q7; subscription mode only
```

- **Overflow** lets work continue past the subscription limit by using
  purchased credits or a pay-per-token API key, only when enabled, and never
  beyond `max_usd`. When overflow is off, work pauses at the limit and
  resumes when the window resets (Q2).
- Overflow spending is reported in the extension, and the owner is notified
  when 80% of `max_usd` is used.
- Any API key is a secret: stored outside Git, never in the manifest or
  logs (S3.1), and scoped to the factory (S8.2).
- Turning overflow on or raising a cap is an owner change to the manifest.
  Agents can't change it (S8.5).

## Security notes

- Pause and resume are owner actions only. The control channel is local
  (named pipe or socket), not reachable from the network.
- Pausing fails safe: if pause state can't be read, the engine starts no new
  sessions for that project.
- Budget limits are owner configuration and change only through the
  hygiene process. Agents can't raise them (S8.5).

## Recommendation

A for Q1 to Q3, Q6 and Q7, and the recommended Q4, Q5 and Q8. Build it as one
feature (engine run control, authorization checks and budgets, plus the
extension's Factory view). The spec interview starts after these decisions.
Q5's onboarding change needs a matching amendment to F-003 (FR-13, FR-15:
calibration and test baseline wait for activation).

## Owner decisions

| Q | Decision (owner, 2026-11-10) |
|---|---|
| Q1 | **Both.** `factory-project.yaml` gets an `enabled: true \| false` flag (not a `paused` flag) as the durable, committed switch. The engine's `project.pause` / `project.resume` methods and the extension's buttons give an instant, temporary pause on top. A project runs only when it is enabled and not paused. |
| Q2 | **Checkpoint and resume, with commits made by the engine, not the agent.** A hook on every file edit in an agent's worktree (the Agent SDK's post-tool hook on edit and write tools) triggers an automatic commit to the agent's branch, so lost work is at most one edit. On resume the engine resumes the same session; if it can't, it starts a new session from the last commit with a summary of the interrupted run's transcript saying what is already done. Squash merge (ADR 0005) keeps these commits out of `main`. |
| Q3 | **A: estimate, admit, reserve.** The fixed starting defaults are replaced by measured values as soon as there is run data. |
| Q4 | **Subscription mode:** the budget is the plan's own usage windows. **Pay-per-token mode:** the owner sets the limits manually. (Aligns with Q8's `mode` setting.) |
| Q5 | **Agreed, with a clarification:** activating a project is the on switch. Once a project is enabled, the factory runs every session needed to finish its queued work, through the whole lifecycle, with no approval per run. The owner still decides inbox items and makes every merge (ADR 0006). "Work starts only from the owner" means a new feature enters a project's queue only from the owner's request or the owner's approval of a suggestion; agents can suggest features but can't queue them. |
| Q7 | **Yes, opt-in, disabled by default.** Feasibility (checked against Claude docs, 2026-11-10): subscription usage windows are visible only through the SDK's `rate_limit_event` (status, `resetsAt`, `utilization`), the experimental `SDKUsageReport` (`rate_limits.limits[]` with `percent` and `resets_at`, plus `extra_usage`), and Claude Code's statusline data. These are enough to build it, but the usage report is marked experimental, so the feature must switch itself off when the data is missing. |
| Q8 | **Calibrated defaults per Claude plan level** (for example Pro, Max 5x, Max 20x), used when there's data for that plan, measured as window utilization per run. Until then, the conservative defaults apply. |

**Open point for the owner (raised with Q7/Q8):** Claude Code's legal and
compliance page says subscription (OAuth) login is meant for ordinary
individual use, and that developers building products or services on the
Agent SDK should use API keys. Before relying on subscription mode for the
engine, the owner should confirm this use fits the plan's terms. Also,
`ANTHROPIC_API_KEY`, when set, takes priority over a subscription login, so
the engine must make the billing mode explicit and refuse to start if the
credentials don't match the project's `mode`.
