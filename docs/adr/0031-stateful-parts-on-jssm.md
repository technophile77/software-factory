# 0031. The engine's stateful parts are modelled with jssm

- **Status:** Accepted
- **Date:** 2026-11-14
- **Decided by:** owner
- **Decision item:** decision card in the thread "Evaluate a state machine library for the engine", 2026-11-14 07:57Z; [proposal 0033](../proposals/0033-feature-lifecycle-state-machine.md)

## Problem

The engine decides what runs next for a feature through if-chains spread
across `engine/src/engine.ts`, and the `stage` event accepts any value.
The increment 3 trial kept hitting reachable states where nobody acted.
See proposal 0033.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| XState 5.33.4 | No dependencies; typed; `xstate/graph` reachability; active team | Verbose definitions; large API |
| Typed table of our own | No dependency; typed | We maintain our own reachability check |
| jssm 5.164.1 | Compact text definition that is also a diagram; enough introspection for a liveness test; small core | State names are untyped strings; one author |
| Not now | Nothing new | Stuck states keep being found one at a time |

## Implications

**Security review (S4.1), 2026-11-14:**

| Item | Finding |
|---|---|
| Source and maintainers | github.com/StoneCypher/jssm, MIT, by John Haugeland (npm `stonecypher`), in production use since 2017, 519 releases. Its two runtime dependencies, `circular_buffer_js` 1.10.0 and `reduce-to-639-1` 1.1.0, are by the same author. Single-author supply chain: one account controls all three |
| Known CVEs | `npm audit` of jssm 5.164.1 and everything it installs: 0 vulnerabilities. The OSV API was not reachable from the review environment; CI's osv-scanner covers it on the PR that adds the dependency (S4.4) |
| Install scripts | None in jssm, its two dependencies, or the optional visualiser packages |
| Permissions it needs | None. The core bundle does not import `fs`, `child_process`, `net`, `http` or `https`, and does not use `eval`, `new Function`, `process.env` or `fetch` (checked by search of `dist/jssm.es5.cjs`) |
| What it pulls in | Runtime: the two packages above. Optional: `@viz-js/viz` 3.31.0 (MIT) and `@resvg/resvg-wasm` 2.6.2 (MPL-2.0), which render diagrams. Peer, optional: CodeMirror and lit, for its editor component, not installed |

**Maintenance.** One author is the main risk: an abandoned or compromised
package. The exact pin (S4.3) and the lockfile limit exposure to a
reviewed version. If jssm stops being maintained, the lifecycle text is
small enough to port to XState or a typed table.

**Performance.** Not a concern: the machine is replayed from a feature's
event log, tens of events.

## Decision

Use jssm 5.164.1, pinned exactly, to model the engine's stateful parts
(the feature lifecycle, agent runs, interview items and inbox items; the
owner widened the scope on 2026-11-14 07:58Z: "it should also be used to
validate that stateful things don't end up in a dead end state"), on
these terms:

1. **The event log stays the source of truth.** The engine builds the
   machine and replays the feature's events into it; jssm's own
   `serialize()` is not persisted.
2. **Typed wrapper.** Engine code never passes raw strings to jssm. A
   module exports the states and actions as `as const` unions and is the
   only caller of jssm; a test fails when those unions and the machine's
   `states()` and actions differ.
3. **Liveness test.** A test walks every state from the machine's
   introspection and fails when a non-final state names no actor, or when
   `has_unenterables()` is true.
4. **No visualiser at runtime.** The engine imports only `jssm`, never
   `jssm/viz`; the esbuild bundle therefore holds only the core. The
   optional visualiser packages still install for development and are
   covered by the CVE checks.

## Consequences

- Feature F-019 specifies the models and the dead-end checks and goes through the
  interview and readiness gate before code (CLAUDE.md rule 1). Its build
  touches `engine/src/engine.ts`, so it starts after PR #60 merges.
- Adds a runtime dependency (H-0230, with the F-019 build).
- Rules out a second state machine library in the engine without a new
  decision.
