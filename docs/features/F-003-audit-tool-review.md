# F-003 Dependency audit tool for Python, Go and Rust: S4.1 review

- **Decision:** Architecture, for the owner. Raised 2026-11-10 after the owner chose "use a tool now" for AC-10.
- **Need:** S4.4 requires every dependency, dev tools included, to be checked against CVE entries in CI, on every change and weekly. npm repos use `npm audit`, which ships with npm. Python, Go and Rust have no built-in equivalent.
- **Recommendation:** Option A, OSV-Scanner, pinned to one release.
- **Owner decision (2026-11-10):** OSV-Scanner approved for every stack. From Beta, Go repos also run govulncheck and Rust repos cargo-audit, for what OSV-Scanner doesn't check. Their S4.1 reviews are below.

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
| Runs repo code? | No. CI runs it with `--no-resolve` (no manifest resolution through deps.dev) and `--no-call-analysis=go` (its default Go call analysis runs the Go toolchain; govulncheck covers that from Beta), so it only parses lock files. Its `fix` command can run package managers; the factory never uses it. |

**Residual risks.** Package names and versions go to osv.dev (public dependency data, not code). An unhashed `requirements.txt` gives less precise results than a lock file, and the assessment already flags a missing lock file (S4.3).

**Pin.** v2.7.1, `osv-scanner_linux_amd64`, SHA-256 `fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8`, matching the release's published `osv-scanner_SHA256SUMS`.

## S4.1 review of govulncheck (Go, from Beta)

| Item | Finding |
|---|---|
| What it adds | Reports which vulnerable functions the code actually calls, so a Go finding can be triaged by reachability. OSV-Scanner reads `go.mod` only. |
| Source and maintainers | `golang.org/x/vuln`, BSD-3-Clause, maintained by the Go team; data from vuln.go.dev. Pinned to v1.9.0 (11 October 2026). |
| Known CVEs | No advisory found against govulncheck itself. |
| Install | `go install golang.org/x/vuln/cmd/govulncheck@v1.9.0`; the Go toolchain checks every module against the Go checksum database, so the pinned version can't be swapped. |
| Permissions needed | Read the checkout; network to the Go module proxy and vuln.go.dev. No token, `contents: read`. |
| Runs repo code? | It type-checks the code without running it. It needs the repo's modules downloaded, which CI does anyway. |

## S4.1 review of cargo-audit (Rust, from Beta)

| Item | Finding |
|---|---|
| What it adds | With `--deny warnings` it fails on yanked crates and on RustSec's unmaintained and unsound warnings, which OSV-Scanner doesn't fail on. |
| Source and maintainers | `rustsec/rustsec`, Apache-2.0/MIT, maintained by the Rust Secure Code Working Group. Pinned to v0.22.2. |
| Known CVEs | No RustSec advisory against cargo-audit itself. Distributors flagged CVEs in bundled dependencies (for example CVE-2024-35197 in gitoxide), fixed by 0.21.2; 0.22.2 includes those fixes. |
| Install | Prebuilt `cargo-audit-x86_64-unknown-linux-gnu-v0.22.2.tgz` from GitHub releases, no build scripts run. The project publishes no checksums, so the SHA-256 `ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39` was taken from the release file during this review and is pinned in the template. |
| Permissions needed | Read `Cargo.lock`; network to GitHub (advisory database) and crates.io (yanked check). No token, `contents: read`. |
| Runs repo code? | No. It parses `Cargo.lock` only. |

## What changed

- The CI template's `dependency-audit` job runs `npm audit` for npm code and OSV-Scanner for Python, Go and Rust code: download at the pinned release, verify the SHA-256, scan the lock files. Any finding fails; an accepted finding goes in `osv-scanner.toml` with a reason and an expiry, as a Security decision.
- The template has `go-vulncheck` and `rust-audit` jobs, added when a repo reaches Beta. The checker reports `stack-audit:go` and `stack-audit:rust` gaps that block Beta when they are missing.
- The AC-10 deviation is withdrawn. Upgrading any pinned version or checksum is a configuration hygiene item.

Sources: [golang.org/x/vuln](https://go.googlesource.com/vuln), [Go vulnerability management](https://go.dev/security/vuln), [cargo-audit packaging CVEs](https://security.snyk.io/package/linux/chainguard%3Alatest/cargo-audit), [google/osv-scanner](https://github.com/google/osv-scanner), [releases](https://github.com/google/osv-scanner/releases), [OSV-Scanner v2 announcement](https://security.googleblog.com/2025/03/announcing-osv-scanner-v2-vulnerability.html), [OSV-SCALIBR CVE-2025-5981](https://advisories.gitlab.com/golang/github.com/google/osv-scalibr/CVE-2025-5981/), [Chainguard advisory for osv-scanner dependencies](https://images.chainguard.dev/security/CGA-x793-9w59-pxpm), [pip-audit](https://pypi.org/project/pip-audit/2.3.2), [RustSec](https://rustsec.org/).
