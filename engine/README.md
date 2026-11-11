# Factory engine

The factory engine (ADR 0001, 0003) is a TypeScript Node process. This package
is F-007 milestone 1, the part that needs no container runtime:

- config, pinned keys and authorization;
- OS secrets;
- the control channel;
- GitHub device approval;
- the engine-only interview transcript on `factory/state`;
- the analyst's interview tools, as plain functions.

Milestone 2 adds the Agent SDK sessions, containers, the proxy and the MCP
wiring.

## Build and test

```
npm ci --ignore-scripts
npm run typecheck
npm run build      # dist/engine.js; koffi stays external and loads its prebuilt binary
npm test           # unit tests (test/*.test.ts) and the acceptance suite (test/acceptance, its own config)
```

The dependencies are pinned exactly in `package.json` and the committed
lockfile. At runtime the only ones are koffi 3.3.6 and yaml 2.9.1.

## Command line

```
factory-engine start   [--master <master repo clone>] [--home <engine folder>] [--gitleaks <path>]
factory-engine confirm --project <config repo path> [--master <path>] [--home <path>]
factory-engine secret set <name>        # reads the value from stdin
```

- `start` runs the engine until `engine.shutdown`, SIGINT or SIGTERM.
- `confirm` accepts a new project path, or a change to a project's pinned
  keys (SR-5). It shows what changed and asks you to type the project name.
  Then the previously pinned owner approves a GitHub device sign-in.
- `secret set` stores `model-credential` or `factory-token/<project>` in the
  OS credential store, under the service `software-factory-engine` (SR-20).

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
| `resumeAnalyst` | none | Called at start for each interrupted analyst run, with its tools and resume plan (FR-14). Milestone 2 starts the SDK session here |

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
| `sync()` | Fetches `factory/state` and checks every transcript against the engine's chain (SR-17). Interview changes the engine didn't make are refused, the feature is closed and a Security item is filed. Other remote changes that fast-forward are adopted |
| `confirmProject(path, io)` | The SR-5 confirm command, using this engine's GitHub, clock and logger. A confirmed project runs after a restart |
| `stop()` | Shuts down: ends sessions, frees the sockets, removes `engine.json` |
| `crash()` | Stops as a kill would. It commits and writes nothing more and leaves `engine.json`, but frees the sockets so a new `startEngine` can run in the same process (AC-12) |
| `stopped` | Resolves once stopped |

The channel version served is `SERVED_CHANNEL_VERSION` (`"1.2"`; see the dev
report for why it isn't 1.3 yet). It is written to each project's
`.factory/engine.json`.
