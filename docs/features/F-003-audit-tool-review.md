# F-003 Dependency audit tool for Python, Go and Rust: S4.1 review

- **Decision:** Architecture, for the owner. Raised 2026-11-10 after the owner chose "use a tool now" for AC-10.
- **Need:** S4.4 requires every dependency, dev tools included, to be checked against CVE entries in CI, on every change and weekly. npm repos use `npm audit`, which ships with npm. Python, Go and Rust have no built-in equivalent.
- **Recommendation:** Option A, OSV-Scanner, pinned to one release.

## Options

| | A. OSV-Scanner (one tool) | B. One tool per stack: pip-audit, govulncheck, cargo-audit |
|---|---|---|
| External components to trust | 1 | 3 |
| How it reads dependencies | Parses lock files (`poetry.lock`, `uv.lock`, `requirements.txt`, `go.mod`, `Cargo.lock`, `package-lock.json` and others) | pip-audit resolves Python requirements and can build source packages, which runs their code unless every requirement is hashed; govulncheck analyses Go source; cargo-audit parses `Cargo.lock` |
| Advisory data | osv.dev, which aggregates GitHub, PyPI, Go and RustSec advisories | PyPI/OSV, Go vulnerability DB, RustSec |
| Reachability | Optional call analysis | govulncheck reports only reachable Go vulnerabilities |
| Upkeep | One version pin, one CI step for all stacks | Three pins and three CI steps |

## S4.1 review of OSV-Scanner

| Item | Finding |
|---|---|
| Source and maintainers | `google/osv-scanner`, Apache-2.0, maintained by Google's open source security team; the frontend to osv.dev. Latest release v2.7.1 (9 November 2026); release commits are signed. |
| Known CVEs | No advisory found against OSV-Scanner itself. Distributors have flagged CVEs in bundled dependencies (go-git CVE-2026-33762, Go standard library CVE-2026-33810), fixed by newer releases. Its extraction library OSV-SCALIBR had CVE-2025-5981, fixed. Pin a release that includes those fixes and keep it under the weekly S4.4 audit. |
| Install scripts | None. It is a prebuilt Go binary from GitHub releases; the project shows SLSA level 3 provenance. CI downloads the pinned binary and verifies its checksum before running it. |
| Permissions needed | Read the checked-out files; network to `api.osv.dev` (and `api.deps.dev` only if it resolves unlocked manifests, which we don't use). No token, no write access: the job keeps `permissions: contents: read`. |
| What it pulls in | Nothing at run time; dependencies are compiled into the binary. |
| Runs repo code? | Scanning parses lock files without running package managers or project code. Its `fix` command can run package managers; the factory never uses it. |

**Residual risks.** Package names and versions go to osv.dev (public dependency data, not code). An unhashed `requirements.txt` gives less precise results than a lock file, and the assessment already flags a missing lock file (S4.3).

## If approved

- The CI template gets one `dependency-audit` step for Python, Go and Rust: download OSV-Scanner at the pinned release, verify its checksum, scan the lock files, and fail on findings at the level's blocking severity.
- `osv-scanner` is added to the checker's audit patterns (already present) and to SKILL.md step 4; the AC-10 deviation is withdrawn.
- Upgrading the pinned version is a configuration hygiene item.

Sources: [google/osv-scanner](https://github.com/google/osv-scanner), [releases](https://github.com/google/osv-scanner/releases), [OSV-Scanner v2 announcement](https://security.googleblog.com/2025/03/announcing-osv-scanner-v2-vulnerability.html), [OSV-SCALIBR CVE-2025-5981](https://advisories.gitlab.com/golang/github.com/google/osv-scalibr/CVE-2025-5981/), [Chainguard advisory for osv-scanner dependencies](https://images.chainguard.dev/security/CGA-x793-9w59-pxpm), [pip-audit](https://pypi.org/project/pip-audit/2.3.2), [RustSec](https://rustsec.org/).
