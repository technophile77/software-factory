# 0035. Ink draws the windowed console

- **Status:** Accepted
- **Date:** 2026-11-20
- **Decided by:** owner
- **Decision item:** F-024 spec v1 sign-off (decision card, 2026-11-20 18:58Z); the owner left the library to the recommendation (18:56Z)

## Problem

F-024 turns `factory-engine inbox` and `interview` into a full-screen console
with tabbed windows that redraws on resize and works in Windows Terminal, the
old Windows console, and macOS and Linux terminals. Drawing that by hand means
our own layout, text wrapping, resize and key handling code.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Ink 8 (React for terminals) | Actively maintained; flexbox layout, resize, key input and Windows support built in; a test renderer for fixed sizes; used by large CLIs | Brings React and a reconciler (about 50 packages, 0 known vulnerabilities on 2026-11-20); a React-shaped UI layer |
| blessed / neo-blessed | Classic widget set (boxes, lists, scrolling) | Unmaintained for years; known Windows rendering issues |
| terminal-kit | Rich, one package | Smaller user base; its own screen buffer model to learn; less test support |
| Hand-written ANSI | No dependency | Our own layout, wrapping, resize and width code to write and maintain; against the owner's rule to prefer existing tools (2026-11-13) |

## Implications

The engine bundle grows by Ink and React, still one file (esbuild). The
console's state stays in plain TypeScript, tested without a terminal; Ink only
draws it, so the drawing layer could be replaced without touching the logic.

## Decision

Ink, with `ink` and `react` pinned to exact versions after the S4.1 review and
CVE check (F-024 SR-4).

## Consequences

Upgrades of Ink and React go through the usual dependency review. `--plain`
keeps the line-by-line console, which uses no Ink.
