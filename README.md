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

## Answer the analyst's spec questions

The same plugin (version 0.2.0 or later) holds the requirements analyst's
interview in a Claude Code chat. Run it inside an onboarded repo or config
repo whose factory engine is running:

```
/software-factory:spec-interview
```

Request a new feature, or pick a feature with questions waiting, then
answer, ask for more information, or defer each question, and approve or
reject the analyst's assumptions. The skill relays questions and replies
word for word and never answers for you. It needs the engine (not built
yet); without it the skill says so and stops. See
[`plugins/software-factory/skills/spec-interview/SKILL.md`](plugins/software-factory/skills/spec-interview/SKILL.md).
