# 0011. Libraries for the VS Code inbox extension

- **Status:** Accepted
- **Date:** 2026-11-09
- **Decided by:** owner (decision card, F-001)

## Problem
The extension parses untrusted YAML frontmatter and renders untrusted Markdown.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Minimal set: `yaml`, `markdown-it` (HTML off); dev: typescript, esbuild, vitest, @vscode/test-electron | Mature, widely used parsers | Two runtime dependencies to keep patched |
| No runtime libraries | No dependencies | Hand-written parsers for untrusted input are riskier |

## Decision
Runtime: `yaml` and `markdown-it` with `html: false`. Development:
`typescript`, `esbuild`, `vitest`, `@vscode/test-electron`. Versions are pinned
exactly and the lockfile is committed. `npm audit` must be clean before each PR.

## Consequences
Raising a version within these libraries is routine. Adding a library needs
a new Architecture decision.
