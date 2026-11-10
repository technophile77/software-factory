# Proposal: coverage tool for the factory's Python code

- **Raised:** 2026-11-10, by the test engineer (F-003) and the validation
  judge (F-003 m27, F-005 m3)
- **Category:** Architecture (a new external tool; S4.1 review below)
- **Status:** Open, awaiting the owner
- **Scope:** the factory repo's own Python code: the plugin skills
  `onboard-repo` and `spec-interview` and their tests. Other projects choose
  their own tools (`testing-strategy.md`, Test tools). This does not approve
  coverage.py for them.

## Problem

`testing-strategy.md` asks for line **and** branch coverage at every level:
"Reported" at Rapid prototype, then 60% / 50% at Alpha and 80% branch on
security-critical code. Today the F-003 and F-005 test engineers measure line
coverage with the standard library's `trace` module. `trace` can't measure
branches, so neither feature has a branch figure, and both validations carry
that as an open minor finding. Under H-0020 the test engineers named
coverage.py as the best fit and left it open instead of substituting, which
is correct, but nobody filed the decision. This is that decision.

Without a branch measure, the factory repo can't be promoted to Alpha.

## Options

### A. coverage.py 7.17.2, test only, hash-pinned (recommended)

Run the existing `unittest` suites under `python -m coverage run --branch`.
coverage.py is never imported by the skills and is not shipped in the plugin,
so the skills stay standard-library only (F-003 FR-12, F-005).

| | |
|---|---|
| Pros | The standard Python coverage tool. Measures branches. No runtime dependencies on Python 3.11+. Works with `unittest` as is. Can follow the subprocesses our acceptance tests start. Current release with fixes |
| Cons | One more external tool to keep patched. 7.17 needs Python 3.11+, so coverage is measured on 3.11 or later. The Python 3.10 compatibility tests still run, just without coverage |

### B. coverage.py 7.16.2, the last release that runs on Python 3.10

| | |
|---|---|
| Pros | Coverage can also be measured on 3.10, the skills' lowest supported version |
| Cons | An older line that gets no more fixes, so a later CVE means a forced upgrade anyway. Coverage figures don't depend on the interpreter version enough to justify this. On 3.10 it also needs `tomli` to read `pyproject.toml` config |

### C. Keep stdlib `trace` (line only)

| | |
|---|---|
| Pros | No external tool |
| Cons | No branch figure, ever. Rapid prototype "Reported" stays half met, and Alpha (50% branch, 80% on security-critical code) can't be shown. A substitute for the best-fit tool also needs the owner's OK under H-0020 |

### D. pytest-cov

| | |
|---|---|
| Pros | Common in pytest projects |
| Cons | It wraps coverage.py, so it adds everything in A plus pytest and its dependencies (pluggy, iniconfig, packaging, Pygments). Our tests use `unittest`, so it adds a test runner change for nothing |

## Security review (S4.1)

Checked 2026-11-10 against coverage.py 7.17.2.

| Item | Finding |
|---|---|
| Source and maintainers | `github.com/coveragepy/coveragepy`, maintained by Ned Batchelder since 2009, Apache-2.0. Released often: 7.16.0 to 7.17.2 in the last ten weeks. Funded through Tidelift |
| Publishing | Every file of 7.17.2 on PyPI carries a trusted-publishing attestation from the `coveragepy/coveragepy` repo's `publish.yml` workflow, so we can tell the files were built by that repo's CI |
| Known CVEs | None. PyPI's vulnerability data (fed from OSV) lists none for 7.17.2 or 7.16.2. A direct OSV query and the GitHub advisory search were blocked from this session; CI re-checks with OSV-Scanner (already approved for Python in F-003) on every change, per S4.4 |
| What it pulls in | Nothing on Python 3.11+. On 3.10 (option B only), `tomli` if config is read from `pyproject.toml` |
| Install scripts | Binary wheels run no code at install. The source package (`tar.gz`) builds a C tracer with `setup.py`, which falls back to pure Python if the compiler fails. Install with `--only-binary :all:` so the source build never runs |
| Startup hook | The wheel installs `a1_coverage.pth`, which Python runs at every interpreter start in that environment. It only imports coverage when `COVERAGE_PROCESS_START` or `COVERAGE_PROCESS_CONFIG` is set; otherwise it does nothing. That is why it goes in a dedicated test virtual environment, never the system Python or the owner's own environment |
| Permissions it needs | Reads the source files it measures and its config. Writes a `.coverage` SQLite file and optional HTML or XML reports in the working directory. No network: the only `socket` use is reading the host name to name parallel data files. Runs as the ordinary user, no elevation (S8.4) |
| Data it handles | Our own source and test code only. Its reports are local files, read by the test engineer as data (S6.1) |

Overall: no blocking findings. The two things to control are the source
build (closed by installing wheels only) and the `.pth` startup hook (closed
by keeping it in a test-only virtual environment).

## Recommendation

Option A. It is the tool both test engineers named, it closes the branch
coverage gap for F-003 and F-005, and it adds no runtime dependency to the
skills.

If approved:

1. The outcome is recorded as an ADR.
2. Configuration hygiene item **H-0065** adds `requirements-test.txt` at the
   repo root, outside the shipped plugin folder:
   ```
   # Test-only tools. Install into a dedicated virtual environment with:
   # pip install --require-hashes --only-binary :all: -r requirements-test.txt
   coverage==7.17.2 \
       --hash=sha256:<one line per published wheel, taken from PyPI at commit time>
   ```
   Every published wheel's hash is listed so Windows, macOS and Linux all
   install with `--require-hashes`.
3. The test engineer re-measures F-003 and F-005 with `--branch` and closes
   F-003 m27 and F-005 m3.

Not part of this decision: running the plugin tests and coverage in CI. The
factory repo's CI has no Python test job yet (only docs checks and the
extension). That is a separate hygiene item to `.github/workflows/`.

## Cost of delay

Low today, since Rapid prototype only asks for coverage to be reported. It
blocks promoting the factory repo to Alpha, and every new Python feature
reports line-only coverage until it is decided.
