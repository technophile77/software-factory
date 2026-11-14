# Agents

One folder per role, each with an `AGENT.md` in Claude Code subagent format
(frontmatter `name`, `description` and `isolation: worktree`, then
instructions). Every agent must have `isolation: worktree` (owner, 2026-11-14,
H-0203); `scripts/check_docs.py` fails without it, and the onboarding checker's
`validate-manifest` fails a project's own agent file without it (H-0205). It takes effect when Claude
Code starts the agent as a subagent. The engine starts each role as its own
Agent SDK session in its own worktree under the tool gate (ADR 0001, 0004,
0026), so engine runs get their isolation from there.

Tool permissions are deliberately left out of the frontmatter: they are open
decision 4. How these files are loaded into Claude Code (for example, linked
into `.claude/agents/`) is part of open decision 2.
