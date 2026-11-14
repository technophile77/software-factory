# Factory engine

The factory engine (ADR 0001, 0003) is a TypeScript Node process. This package
is F-007, the first engine increment: real spec interviews. It holds:

- config, pinned keys and authorization;
- OS secrets;
- the control channel;
- GitHub device approval;
- the engine-only interview transcript on `factory/state`;
- the analyst's interview tools;
- the parts that run agents in containers:

| Folder | What it holds |
|---|---|
| `src/policy/` | Role policy v2.5 from the manifest, the H-0046 glob dialect and the ADR 0015 path rule |
| `src/docker/` | the `docker` command line (SR-14), container and network plans, the post-start `docker inspect` check, and the agent image build |
| `src/proxy/` | the sidecar proxy and credential gateway (SR-6 to SR-9), on Node built-ins only; bundled to `dist/proxy.js` |
| `src/agent/` | session options (SR-10), the container spawn, SR-18 caps, the `factory` MCP tools, `fetch_page`, the web reader, the worktree commit and end-of-session write check (FR-9, FR-11) |
| `docker/` | the agent image: base image by digest, Claude Code 2.1.311 checked against the Agent SDK manifest, no npm in the final stage |
| `config/limits.yaml` | the session, container and interview limits (H-0087), change-controlled. The engine reads it from the master commit the project's `factory.version` tag names, never a working tree. A project's manifest `limits:` may only lower a value; a higher one stops the project and files a Security item |
| `config/models.yaml` | the model for each agent role until F-002 wires rungs (spec v32), change-controlled. Read like `limits.yaml`, from the `factory.version` commit; a missing role, an unknown role or an empty model id stops the project and files a Security item |

Session code is written against `src/agent/sdk.ts`, the part of the Agent
SDK's surface the engine uses; `src/agent/sdk-binding.ts` maps it onto the
real SDK 0.3.311. `.npmrc` sets `legacy-peer-deps=true` (owner decision):
the SDK's type-only peers aren't installed. The SDK's platform package puts a
Claude Code binary on the host; the engine never runs it, because every
session starts Claude Code in its container through the engine's spawn. Only
tests run it (`test/claude-real.test.ts`, `test/acceptance/settings-isolation.test.ts`),
in a scratch folder against a local fake API with a dummy key.

The real-Docker tests are gated: set `FACTORY_DOCKER_TESTS=1` with Docker
running, then run `npx vitest run --config test/acceptance/vitest.config.mts containers-real`
and `npx vitest run test/docker-real.test.ts`.

## Build and test

```
npm ci --ignore-scripts
npm run typecheck
npm run build      # dist/engine.js (koffi stays external) and dist/proxy.js (the sidecar proxy)
npm test           # unit tests (test/*.test.ts) and the acceptance suite (test/acceptance, its own config)
npm run test:platform  # only the files that exercise OS-specific code (what PRs run on macOS and Windows)
npm run coverage   # the same with V8 coverage; reported, not gated
```

To put `factory-engine` on your PATH, run `npm link` once in this folder
after the first build. npm adds a `factory-engine` command (a `.cmd` shim on
Windows) in its global bin folder that points at this checkout's
`dist/engine.js`, so later builds need no relink. `npm unlink -g
software-factory-engine` removes it.

CI splits the suite across several runners per OS. `FACTORY_TEST_SHARD=k/n`
runs only shard k of n: every test file, but only its share of each file's
tests (`test/shard.ts`). Unset, everything runs. To rerun one CI shard
locally: `FACTORY_TEST_SHARD=2/5 npm test`. On PRs, macOS and Windows run
only `test:platform`; pushes to `main` and the nightly run test everything
on all three OSes. A new test file that touches platform code (pipes,
ACLs, paths, process spawning, the credential store) belongs in that list.

Tests that need a real Docker daemon are skipped unless
`FACTORY_DOCKER_TESTS=1`. Run them after `npm run build`:

```
FACTORY_DOCKER_TESTS=1 npx vitest run --project unit test/docker-real.test.ts
```

The dependencies are pinned exactly in `package.json` and the committed
lockfile. At runtime: koffi 3.3.6, yaml 2.9.1, the Agent SDK 0.3.311, zod 4.6.7 and the
MCP TypeScript SDK 1.32.2 (its stdio server only).

## Command line

```
factory-engine start   [--master <master repo clone>] [--home <engine folder>] [--gitleaks <path>]
factory-engine confirm --project <config repo path> [--master <path>] [--home <path>]
factory-engine secret set <name>        # reads the value from stdin
factory-engine mcp                      # started by Claude Code, not by hand
```

- `start` runs the engine until `engine.shutdown`, SIGINT or SIGTERM.
- `confirm` accepts a new project path, or a change to a project's pinned
  keys (SR-5). It shows what changed and asks you to type the project name.
  Then the previously pinned owner approves a GitHub device sign-in.
- `secret set` stores `model-credential` or `factory-token/<project>` in the
  OS credential store, under the service `software-factory-engine` (SR-20).
- `interview [<feature id>] [--project <path>]` is where the owner answers
  the analyst (F-018, ADR 0029): it prints each item word for word and reads
  the answer from the keyboard, talking to the running engine over the
  control channel. It runs only in a terminal and never starts the engine.

The gitleaks binary's absolute path comes from `--gitleaks` or from
`gitleaks:` in `<engine home>/engine.yaml`. The engine refuses to run any
build other than the pinned one.

The engine home defaults to:

- Linux and macOS: `~/.software-factory/engine`
- Windows: `%LOCALAPPDATA%\software-factory\engine`

It holds the pinned keys, the engine record (chain heads, runs), logs and
sockets, and lives outside every repo.

## In-process API

```ts
import { startEngine } from "./src/index";

const engine = await startEngine({
  masterRepo: "/path/to/software-factory",       // holds factory-projects.local.yaml
  gitleaks: { path: "/usr/local/bin/gitleaks" },
});
// engine.projects: one status per listed project (running, stopped with a reason, or disabled)
// engine.interviewTools(feature, analystWorktree, { model, effort }): the analyst's five tools
await engine.stop();
```

`startEngine(options)` returns once every project is either serving or stopped
with a reason. It throws `StartError` only for faults that stop the whole
engine:

- git, the gitleaks build or the credential store can't be used;
- the paths file is refused (SR-13);
- the credentials don't match a project's billing mode (FR-3, ADR 0012);
- a channel can't be served.

A feature id found in more than one project is handled differently. That id
alone is refused, and a Security item is filed (SR-16).

Every outside dependency can be injected:

| Option | Default | What a test passes instead |
|---|---|---|
| `masterRepo` | (required) | A temporary master repo |
| `gitleaks` | (required) `{ path, timeoutS?, expectSha256? }` | A fake scanner script and its SHA-256 |
| `scanner` | gitleaks at `gitleaks.path` | Any `SecretsScanner` |
| `engineHome` | see above | A temporary folder |
| `runtimeDir` | `<engineHome>/run` | A short temporary folder (socket paths are limited to about 100 bytes) |
| `gitPath` | `git` found on `PATH` | An absolute path |
| `credentials` | `OsCredentialStore` (koffi) | `MemoryCredentialStore` |
| `github` | `HttpGitHub` on github.com | A `GitHubClient`, or `{ webBase, apiBase }` for a fake GitHub over HTTP (https, or loopback http) |
| `clock` | `systemClock` | A clock that moves only when told |
| `os` | `realOsApi()` (koffi) | An `OsApi` whose peer checks, pipe or ACL calls are faked |
| `env` | `process.env` | The environment the billing check reads |
| `logger` | `FileLogger` in `<engineHome>/logs` | `MemoryLogger` |
| `parentOf` | `/proc` on Linux | A function from pid to parent pid |
| `push` | `false` (the CLI sets `true`) | Talk to each project's remote: fetch `factory/state` at start and on `sync()`, and push it after each commit |
| `resumeAnalyst` | none | Called at start for each interrupted analyst run when `agents` isn't given, with its tools and resume plan (FR-14) |
| `agents` | none (the CLI passes Docker on its local endpoint and the Agent SDK) | `{ docker, sdk, dockerDir, proxyScript }` fakes. With it, `feature.start` and each resume run the analyst in its container, and leftovers of a killed engine are swept at start |

Pushes and fetches go only to `<webBase>/<owner>/<repo>.git`, where
`webBase` is the GitHub web base (`https://github.com` unless injected) and
owner and repo come from the config repo's `origin`. Any other `origin` is
neither pushed to nor fetched from. A loopback `http://` base works only when
passed in through these options. Config and the CLI can't set it.

The handle offers:

| Member | What it does |
|---|---|
| `projects` | Each listed project's status |
| `runs` | The run book: running, interrupted, complete and failed runs |
| `feature(id)` | One feature's interview |
| `interviewTools(feature, worktree, facts?)` | The analyst's five tools. The first call starts the feature's analyst run |
| `sync()` | Fetches `factory/state` and checks every transcript against the engine's chain (SR-17). Interview changes on the remote that the engine didn't make are not adopted: a Security item is filed and the feature's readiness checks fail. A local transcript edit closes the feature. Other remote changes that fast-forward are adopted |
| `confirmProject(path, io)` | The SR-5 confirm command, using this engine's GitHub, clock and logger. A confirmed project runs after a restart |
| `limits(project)` | A running project's effective limits (H-0087): the defaults at its `factory.version` commit, lowered by the manifest's `limits:` |
| `agentSources(project)` | Spec v30: the master commit, the config repo commit, each role's `AGENT.md` and baked skills, with the project's overrides winning |
| `instructions(project, role)` | A role's `AGENT.md`; throws when the role has none, so it can't run |
| `stop()` | Shuts down: ends sessions, frees the sockets, removes `engine.json` |
| `crash()` | Stops as a kill would. It commits and writes nothing more and leaves `engine.json`, but frees the sockets so a new `startEngine` can run in the same process (AC-12) |
| `stopped` | Resolves once stopped |

The channel version served is `SERVED_CHANNEL_VERSION` (`"1.2"`; see the dev
report for why it isn't 1.3 yet). It is written to each project's
`.factory/engine.json`.
