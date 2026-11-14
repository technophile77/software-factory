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
/plugin marketplace add technophile77/software-factory@v0.4.0
/plugin install software-factory@software-factory
/software-factory:onboard-repo
```

Add the marketplace at a release tag, never at `main`, so you run the
release you chose. To move to a newer release, remove the marketplace and
add it again at the new tag. Each release tag is `v` plus the `version` in
`plugins/software-factory/.claude-plugin/plugin.json`.

See [`plugins/software-factory/skills/onboard-repo/SKILL.md`](plugins/software-factory/skills/onboard-repo/SKILL.md).

## Answer the analyst's spec questions

Answer the requirements analyst in a terminal on the PC where the factory
engine runs (F-018, ADR 0029), inside an onboarded repo or config repo:

```
factory-engine interview [<feature id>] [--project <path>]
```

Request a new feature, or pick a feature with questions waiting, then
answer, ask for more information, or defer each question, and approve or
reject the analyst's assumptions. On any question you can also ask the
advisor, a separate agent on a stronger model, and you approve or decline
the analyst's own proposals to ask it (F-006); its advice is shown beside
the question, labelled as the advisor's. The command prints each item word
for word, with no model in between, and never answers for you. While the
factory works it shows what it is doing. It needs a running factory engine;
without it the command says so and stops. How often you sign in to GitHub
to answer is the project's `settings.interview_sign_in` (F-018 FR-15).
