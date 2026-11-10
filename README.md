# Software Factory

An agent-driven software factory, used from VS Code and Claude Code. It takes
a feature from a natural-language request through requirements, security
review, implementation, independent testing, validation, and a pull request,
and brings the owner in only for the decisions that are theirs.

**Status:** foundation only. The docs, agent roles, and workflow are drafted.
The VS Code extension and the orchestration engine are not built yet, because
the design items they depend on are still open
(see [`docs/open-decisions.md`](docs/open-decisions.md)).

Start with [`CLAUDE.md`](CLAUDE.md) and the
[spec](docs/spec/software-factory-spec-v0.1.md).

## Onboard a repository

Install the factory's plugin once, then run it inside any repository:

```
/plugin marketplace add technophile77/software-factory
/plugin install software-factory@software-factory
/software-factory:onboard-repo
```

See [`plugins/software-factory/skills/onboard-repo/SKILL.md`](plugins/software-factory/skills/onboard-repo/SKILL.md).
