#!/usr/bin/env python3
"""Deterministic checks for the onboard-repo skill (F-003).

Standard library only (FR-12), so the skill works when copied into any repo
and adds no external component to review (S4.1). The script reads files and
runs local `git` only; it never runs the target repo's code (SR-2) and never
touches the network.

Subcommands:
  assess            inspect a repo and write the assessment (JSON + Markdown)
  validate-manifest check a factory-project.yaml against Project manifest v1.0
  plan-items        file decision items for an assessment, skipping ones already filed
  plugin-version    print this plugin's release tag; with --manifest, check it is the pinned one
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile

SCHEMA = "onboarding-assessment/1.0"
LEVELS = ["rapid-prototype", "alpha", "beta", "release", "production-ready"]
SEVERITY_BLOCKS = {"critical": "rapid-prototype", "high": "alpha", "medium": "release", "low": None}
CORE_AGENTS = [
    "orchestrator", "requirements-analyst", "software-developer",
    "test-engineer", "security-reviewer", "validation-judge",
]
# Optional roles the master factory ships; a manifest may give them a policy.
SUPPORT_AGENTS = ["web-reader"]
PROTECTED = set(CORE_AGENTS) | {"security-review"}
DEFAULT_SKILLS = ["security-review"]
COMPLEXITY = ["simple", "moderate", "complex"]

MAX_SCAN_BYTES = 1_000_000
# Walked only when the folder isn't a git repo; tracked files are always scanned.
WALK_SKIP = {".git", "node_modules", ".venv", "venv", "__pycache__", ".factory"}
# Third-party or generated folders: scanned for secrets, ignored for stack and test detection.
VENDORED = {"node_modules", "vendor", ".venv", "venv", "dist", "build", "target", "third_party"}


class CheckError(Exception):
    pass


def level_index(level):
    return LEVELS.index(level) if level in LEVELS else None


def min_level(*levels):
    known = [l for l in levels if l in LEVELS]
    return min(known, key=LEVELS.index) if known else None


# ---------------------------------------------------------------------------
# Minimal YAML reader for factory files (manifests, maturity records).
# It accepts the subset the factory writes and rejects everything else,
# so an unreadable file is an error, never a silent pass (SR-8).
# ---------------------------------------------------------------------------

class YamlError(CheckError):
    pass


def _strip_comment(text):
    out, quote = [], None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"" and (not text[:i].strip() or text[:i].rstrip()[-1] in ":[{,-"):
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


def _split_flow(inner, lineno):
    parts, depth, quote, cur = [], 0, None, []
    for ch in inner:
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if quote or depth:
        raise YamlError(f"line {lineno}: unbalanced flow collection")
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def _scalar(text, lineno):
    t = text.strip()
    if t == "" or t in ("~", "null"):
        return None
    if t[0] in "&*!" or t.startswith(("? ", "%")):
        raise YamlError(f"line {lineno}: anchors, aliases, tags and directives are not supported")
    if t.startswith("["):
        if not t.endswith("]"):
            raise YamlError(f"line {lineno}: unterminated flow sequence")
        return [_scalar(p, lineno) for p in _split_flow(t[1:-1], lineno)]
    if t.startswith("{"):
        if not t.endswith("}"):
            raise YamlError(f"line {lineno}: unterminated flow mapping")
        result = {}
        for p in _split_flow(t[1:-1], lineno):
            k, sep, v = p.partition(":")
            if not sep:
                raise YamlError(f"line {lineno}: flow mapping entry without ':'")
            result[_scalar(k, lineno)] = _scalar(v, lineno)
        return result
    if t[0] == '"':
        if len(t) < 2 or not t.endswith('"'):
            raise YamlError(f"line {lineno}: unterminated string")
        try:
            return json.loads(t)
        except json.JSONDecodeError as e:
            raise YamlError(f"line {lineno}: bad double-quoted string") from e
    if t[0] == "'":
        if len(t) < 2 or not t.endswith("'"):
            raise YamlError(f"line {lineno}: unterminated string")
        return t[1:-1].replace("''", "'")
    if t in ("true", "True"):
        return True
    if t in ("false", "False"):
        return False
    if re.fullmatch(r"-?\d+", t):
        return int(t)
    return t


def _key_value(text, lineno):
    if text.startswith(("'", '"')):
        q = text[0]
        end = text.find(q, 1)
        if end < 0 or text[end + 1:end + 2] != ":":
            raise YamlError(f"line {lineno}: bad quoted key")
        return text[1:end], text[end + 2:]
    m = re.match(r"([^\s:#][^:]*?):(?:\s|$)(.*)$", text)
    if not m:
        return None
    return m.group(1), m.group(2)


def parse_yaml(source):
    raw = source.splitlines()
    lines = []  # (indent, text, lineno, raw_line)
    started = False
    for n, line in enumerate(raw, 1):
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise YamlError(f"line {n}: tab in indentation")
        stripped = line.strip()
        if stripped == "---":
            if started or any(_strip_comment(l[1]).strip() for l in lines):
                raise YamlError(f"line {n}: only one document is supported")
            started = True
            continue
        lines.append((len(line) - len(line.lstrip(" ")), line, n))
    pos = [0]

    def significant(i):
        while i < len(lines):
            text = _strip_comment(lines[i][1]).strip()
            if text:
                return i
            i += 1
        return i

    def block_scalar(indent_parent, style):
        collected, i = [], pos[0]
        block_indent = None
        while i < len(lines):
            ind, line, _ = lines[i]
            if line.strip() == "":
                collected.append("")
                i += 1
                continue
            if ind <= indent_parent:
                break
            if block_indent is None:
                block_indent = ind
            if ind < block_indent:
                break
            collected.append(line[block_indent:])
            i += 1
        pos[0] = i
        while collected and collected[-1] == "":
            collected.pop()
        joiner = "\n" if style == "|" else " "
        return joiner.join(collected) + ("\n" if style == "|" and collected else "")

    def value_after(rest, indent, lineno):
        rest = _strip_comment(rest).strip()
        if rest in ("|", ">", "|-", ">-"):
            return block_scalar(indent, rest[0])
        if rest == "":
            i = significant(pos[0])
            if i < len(lines) and lines[i][0] > indent:
                pos[0] = i
                return parse_block(lines[i][0])
            if i < len(lines) and lines[i][0] == indent and _strip_comment(lines[i][1]).strip().startswith("- "):
                pos[0] = i
                return parse_block(indent)
            return None
        return _scalar(rest, lineno)

    def parse_block(indent):
        i = significant(pos[0])
        if i >= len(lines):
            return None
        first = _strip_comment(lines[i][1]).strip()
        if first == "-" or first.startswith("- "):
            return parse_seq(indent)
        return parse_map(indent)

    def parse_map(indent):
        result = {}
        while True:
            i = significant(pos[0])
            if i >= len(lines):
                break
            ind, line, n = lines[i]
            if ind < indent:
                break
            if ind > indent:
                raise YamlError(f"line {n}: unexpected indentation")
            text = _strip_comment(line).strip()
            if text.startswith("- "):
                break
            kv = _key_value(text, n)
            if kv is None:
                raise YamlError(f"line {n}: expected 'key: value'")
            key, rest = kv
            if key in result:
                raise YamlError(f"line {n}: duplicate key {key!r}")
            pos[0] = i + 1
            result[key] = value_after(rest, indent, n)
        return result

    def parse_seq(indent):
        result = []
        while True:
            i = significant(pos[0])
            if i >= len(lines):
                break
            ind, line, n = lines[i]
            text = _strip_comment(line).strip()
            if ind != indent or not (text == "-" or text.startswith("- ")):
                if ind > indent:
                    raise YamlError(f"line {n}: unexpected indentation")
                break
            item = text[1:].strip()
            pos[0] = i + 1
            if item == "":
                result.append(value_after("", indent, n))
                continue
            kv = _key_value(item, n) if not item.startswith(("[", "{")) else None
            if kv is None:
                result.append(_scalar(item, n))
                continue
            # "- key: value" opens a mapping whose keys sit two columns in.
            child_indent = indent + (len(text) - len(item)) + (ind - indent)
            key, rest = kv
            mapping = {key: value_after(rest, child_indent, n)}
            j = significant(pos[0])
            if j < len(lines) and lines[j][0] == child_indent and not _strip_comment(lines[j][1]).strip().startswith("- "):
                more = parse_map(child_indent)
                for k in more:
                    if k in mapping:
                        raise YamlError(f"line {n}: duplicate key {k!r}")
                mapping.update(more)
            result.append(mapping)
        return result

    i = significant(0)
    if i >= len(lines):
        return None
    pos[0] = i
    data = parse_block(lines[i][0])
    rest = significant(pos[0])
    if rest < len(lines):
        raise YamlError(f"line {lines[rest][2]}: could not parse")
    return data


# ---------------------------------------------------------------------------
# Repo walking. Paths stay inside the root; symlinks are reported, not
# followed (SR-4).
# ---------------------------------------------------------------------------

def run_git(root, *args):
    try:
        # A repo's own .git/config could name commands for git to run; switch them off.
        proc = subprocess.run(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, *args],
                              capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return proc.stdout if proc.returncode == 0 else None


class Repo:
    def __init__(self, root):
        self.root = os.path.realpath(root)
        if not os.path.isdir(self.root):
            raise CheckError(f"not a directory: {root}")
        self.symlinks = []
        self.files = self._list_files()

    def _list_files(self):
        out = run_git(self.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
        if out is not None:
            candidates = [p for p in out.decode("utf-8", "replace").split("\0") if p]
        else:
            candidates = []
            for dirpath, dirnames, filenames in os.walk(self.root, followlinks=False):
                dirnames[:] = [d for d in dirnames if d not in WALK_SKIP]
                for d in list(dirnames):
                    if os.path.islink(os.path.join(dirpath, d)):
                        candidates.append(os.path.relpath(os.path.join(dirpath, d), self.root))
                for f in filenames:
                    candidates.append(os.path.relpath(os.path.join(dirpath, f), self.root))
        cached = run_git(self.root, "ls-files", "-z", "--cached", "--", ".factory") if out is not None else None
        tracked = {p for p in (cached or b"").decode("utf-8", "replace").split("\0") if p}
        files = []
        for rel in sorted(set(candidates)):
            rel = rel.replace(os.sep, "/")
            # The factory/state worktree at .factory is skipped, but anything the
            # repo itself tracks there is repo content and is scanned like the rest.
            if rel.split("/")[0] == ".git" or (rel.split("/")[0] == ".factory" and rel not in tracked):
                continue
            full = os.path.join(self.root, rel)
            if os.path.islink(full):
                target = os.path.realpath(full)
                if not (target == self.root or target.startswith(self.root + os.sep)):
                    self.symlinks.append(rel)
                continue
            if os.path.isfile(full):
                files.append(rel)
        return files

    def path(self, rel):
        full = os.path.realpath(os.path.join(self.root, rel))
        if not (full == self.root or full.startswith(self.root + os.sep)):
            raise CheckError(f"path escapes repo: {rel}")
        return full

    @property
    def own_files(self):
        return [f for f in self.files if not set(f.split("/")[:-1]) & VENDORED]

    def exists(self, rel):
        return rel in self.files

    def read(self, rel, limit=MAX_SCAN_BYTES):
        full = self.path(rel)
        if os.path.getsize(full) > limit:
            return None
        with open(full, "rb") as f:
            data = f.read()
        if b"\0" in data[:8192]:
            return None
        return data.decode("utf-8", "replace")

    def basenames(self, *names):
        return [f for f in self.own_files if f.rsplit("/", 1)[-1] in names]


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

STACKS = {
    "npm": {"manifests": ["package.json"], "locks": ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]},
    "python": {"manifests": ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"], "locks": ["poetry.lock", "uv.lock", "Pipfile.lock", "pdm.lock"]},
    "go": {"manifests": ["go.mod"], "locks": ["go.sum"]},
    "rust": {"manifests": ["Cargo.toml"], "locks": ["Cargo.lock"]},
}

TEST_TOOLS = {
    "npm": [r"\"(jest|vitest|mocha|ava|tap|@playwright/test|cypress)\"", r"node --test"],
    "python": [r"\bpytest\b", r"\bunittest\b", r"\bnose2\b"],
    "go": [r"_test\.go$"],
    "rust": [r"#\[test\]", r"#\[cfg\(test\)\]"],
}
COVERAGE_TOOLS = [r"\bc8\b", r"\bnyc\b", r"--coverage", r"@vitest/coverage", r"\bpytest-cov\b", r"--cov\b", r"\bcoverage(\.py)?\b run",
                  r"\.coveragerc", r"\[tool\.coverage", r"-cover(profile)?\b", r"cargo[- ](llvm-cov|tarpaulin)", r"\bcollectCoverage\b"]
PROPERTY_TOOLS = [r"\bfast-check\b", r"\bhypothesis\b", r"\bproptest\b", r"\bquickcheck\b", r"testing/quick", r"\bgopter\b", r"\brapid\b\"?\s*$"]
FUZZ_TOOLS = [r"\bfunc Fuzz\w*\(", r"\batheris\b", r"\bjazzer\b", r"cargo-fuzz", r"libfuzzer-sys", r"@jazzer\.js"]
MUTATION_TOOLS = [r"\bstryker\b", r"\bmutmut\b", r"\bcosmic-ray\b", r"cargo-mutants", r"go-mutesting", r"\bgremlins\b"]
AUDIT_PATTERNS = [r"npm audit", r"yarn (npm )?audit", r"pnpm audit", r"pip-audit", r"\bsafety check\b", r"govulncheck",
                  r"cargo[- ]audit", r"cargo[- ]deny", r"osv-scanner", r"dependency-review-action", r"\btrivy\b", r"\bgrype\b"]
STACK_AUDITS = [
    ("go", "govulncheck", r"\bgovulncheck\b",
     "it reports which vulnerable functions the code actually calls."),
    ("rust", "cargo-audit", r"\bcargo[- ](audit|deny)\b",  # cargo-deny's advisories check covers the same
     "it also fails on yanked, unmaintained and unsound crates."),
]
SECRET_SCAN_PATTERNS = [r"gitleaks", r"trufflehog", r"detect-secrets", r"secret[-_ ]?scan"]

TOOL_CANDIDATES = {
    "test-framework": {
        "npm": ["node:test (built in, no new dependency)", "vitest", "jest"],
        "python": ["unittest (standard library, no new dependency)", "pytest"],
        "go": ["go test (built in)"],
        "rust": ["cargo test (built in)"],
    },
    "coverage": {
        "npm": ["node --experimental-test-coverage (built in)", "c8", "@vitest/coverage-v8"],
        "python": ["coverage.py", "pytest-cov (wraps coverage.py)"],
        "go": ["go test -coverprofile (built in)"],
        "rust": ["cargo-llvm-cov", "cargo-tarpaulin"],
    },
    "property-testing": {
        "npm": ["fast-check"],
        "python": ["hypothesis"],
        "go": ["testing/quick (standard library)", "pgregory.net/rapid"],
        "rust": ["proptest", "quickcheck"],
    },
    "fuzzing": {
        "npm": ["@jazzer.js/core"],
        "python": ["atheris"],
        "go": ["go test -fuzz (built in)"],
        "rust": ["cargo-fuzz"],
    },
    "mutation": {
        "npm": ["@stryker-mutator/core"],
        "python": ["mutmut", "cosmic-ray"],
        "go": ["gremlins", "go-mutesting"],
        "rust": ["cargo-mutants"],
    },
}

SECRET_RULES = [
    ("aws-access-key", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("private-key", re.compile(r"-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("stripe-live-key", re.compile(r"\b[sr]k_live_[0-9A-Za-z]{20,}\b")),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("gitlab-token", re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b")),
    ("ai-api-key", re.compile(r"\bsk-(ant-|proj-)?[A-Za-z0-9_\-]{32,}\b")),
]
# Only in .env-style files, where any non-empty value is likely real.
ENV_SECRET = re.compile(r"^\s*(export\s+)?[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*['\"]?[^\s'\"#$]{6,}")


def detect_stacks(repo):
    stacks = []
    for name, spec in STACKS.items():
        for manifest in repo.basenames(*spec["manifests"]):
            directory = manifest.rsplit("/", 1)[0] if "/" in manifest else "."
            if any(s["name"] == name and s["dir"] == directory for s in stacks):
                continue
            locks = [l for l in spec["locks"] if repo.exists(l if directory == "." else f"{directory}/{l}")]
            if name == "python" and not locks:
                req = "requirements.txt" if directory == "." else f"{directory}/requirements.txt"
                if repo.exists(req) and _requirements_pinned(repo.read(req) or ""):
                    locks = ["requirements.txt (all pinned with ==)"]
            stacks.append({"name": name, "dir": directory, "manifest": manifest, "locks": locks})
    return stacks


def _requirements_pinned(text):
    reqs = [l.split("#")[0].strip() for l in text.splitlines()]
    reqs = [r for r in reqs if r and not r.startswith("-")]
    return bool(reqs) and all("==" in r for r in reqs)


def _search(texts, patterns):
    for path, text in texts:
        for pat in patterns:
            if re.search(pat, text, re.M):
                return path
    return None


# ---------------------------------------------------------------------------
# Workflows are read line by line, not parsed: a crafted file can't break
# the reader, and anything unreadable is a gap (SR-8).
# ---------------------------------------------------------------------------

def scan_workflow(text):
    info = {"top_permissions": None, "jobs": {}, "uses": [], "schedule": False, "on_push_or_pr": False,
            "crons": []}
    lines = text.splitlines()
    in_jobs = False
    current_job = None
    job_indent = None
    in_on = False
    for n, raw in enumerate(lines, 1):
        line = _strip_comment(raw)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        s = line.strip()
        if re.search(r"\bpull_request_target\b", s):
            info["pr_target"] = info.get("pr_target") or n
        if re.search(r"permissions['\"]?\s*:\s*['\"]?write-all", s):
            info["write_all"] = info.get("write_all") or n
        for m in re.finditer(r"['\"]?\buses['\"]?\s*:\s*['\"]?([^'\"\s,}\]]+)", s):
            info["uses"].append((n, m.group(1)))
        for m in re.finditer(r"['\"]?\bcron['\"]?\s*:\s*['\"]([^'\"]+)['\"]", s):
            info["crons"].append(m.group(1))
        if indent == 0:
            in_jobs = s.startswith("jobs:")
            in_on = s.startswith(("on:", '"on":', "'on':", "true:"))
            if s.startswith("permissions:"):
                info["top_permissions"] = n
            if in_on and re.search(r"\b(push|pull_request)\b", s):
                info["on_push_or_pr"] = True
            current_job = None
            continue
        if in_on and re.match(r"(push|pull_request|pull_request_target)\b", s):
            info["on_push_or_pr"] = True
        if in_on and s.startswith("schedule"):
            info["schedule"] = True
        if in_jobs:
            if job_indent is None:
                job_indent = indent
            if indent == job_indent and s.endswith(":"):
                current_job = s[:-1].strip("'\"")
                info["jobs"][current_job] = {"line": n, "permissions": None, "text": []}
                continue
            if current_job:
                job = info["jobs"][current_job]
                job["text"].append(s)
                if indent == job_indent + 2 and s.startswith("permissions:"):
                    job["permissions"] = n
        m = re.match(r"-?\s*cron:\s*([^'\"].*)$", s)
        if m:
            info["crons"].append(m.group(1).strip())

    return info


def weekly_or_more(cron):
    fields = cron.split()
    # Day of month and month must be open; any day-of-week then runs at least weekly.
    return len(fields) == 5 and fields[2] == "*" and fields[3] == "*"


def action_pinned(ref):
    if ref.startswith("./"):
        return True
    if ref.startswith("docker://"):
        return "@sha256:" in ref
    _, _, version = ref.partition("@")
    return bool(re.fullmatch(r"[0-9a-f]{40}", version))


# ---------------------------------------------------------------------------
# Assessment
# ---------------------------------------------------------------------------

def gap(gid, title, rule, category, blocks, fix, resolution, evidence=None, severity=None):
    g = {
        "id": gid, "title": title, "rule": rule, "category": category,
        "blocks_level": blocks, "evidence": evidence or [], "fix": fix, "resolution": resolution,
    }
    if severity:
        g["severity"] = severity
    return g


def ev(path=None, line=None, detail=None):
    e = {}
    if path:
        e["path"] = path
    if line:
        e["line"] = line
    if detail:
        e["detail"] = detail
    return e


CI_JOBS = [
    # (job id, level first required, keyword patterns, resolution)
    ("build", "rapid-prototype", [r"\bbuild\b", r"\bcompile\b", r"tsc\b", r"cargo build", r"go build", r"python -m build"], "onboarding-pr"),
    ("smoke-test", "rapid-prototype", [r"\bsmoke\b"], "onboarding-pr"),
    ("unit-tests", "alpha", [r"npm (run )?test", r"\bpytest\b", r"unittest", r"go test", r"cargo test", r"\bvitest\b", r"\bjest\b", r"node --test"], "onboarding-pr"),
    ("acceptance-tests", "alpha", [r"acceptance", r"\be2e\b", r"playwright", r"cypress"], "feature-request"),
    ("secret-scan", "alpha", SECRET_SCAN_PATTERNS, "onboarding-pr"),
    ("contract-tests", "beta", [r"\bcontract\b", r"\bpact\b"], "feature-request"),
    ("integration-tests", "beta", [r"integration"], "feature-request"),
    ("dependency-audit", "beta", AUDIT_PATTERNS, "onboarding-pr"),
    ("full-regression", "release", [r"regression"], "feature-request"),
    ("performance-tests", "release", [r"\bperf(ormance)?\b", r"benchmark", r"\bk6\b", r"locust", r"\bbench\b"], "feature-request"),
    ("coverage-report", "release", COVERAGE_TOOLS, "onboarding-pr"),
]


def assess(root, github_protection=None, previous=None, level=None, now=None):
    repo = Repo(root)
    now = now or dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    gaps = []
    texts_cache = {}

    def text_of(rel):
        if rel not in texts_cache:
            try:
                texts_cache[rel] = repo.read(rel)
            except OSError:
                texts_cache[rel] = None
        return texts_cache[rel]

    stacks = detect_stacks(repo)
    if not stacks:
        gaps.append(gap("stack-unknown", "No supported stack detected", "F-003 FR-1", "config", None,
                        "Tell the factory how to build and test this repo; the CI workflow and tool choices depend on it.",
                        "owner-step", [ev(detail="looked for: " + ", ".join(sorted({m for s in STACKS.values() for m in s["manifests"]})))]))
    for s in stacks:
        if not s["locks"]:
            gaps.append(gap(f"lock-missing:{s['name']}:{s['dir']}", f"No lock file for {s['name']} in {s['dir']}", "S4.3",
                            "security", SEVERITY_BLOCKS["medium"],
                            "Commit a lock file so every install resolves the same versions.", "onboarding-pr",
                            [ev(s["manifest"], detail="expected one of: " + ", ".join(STACKS[s["name"]]["locks"]))], "medium"))

    # Text corpus for tool detection: manifests, config and test files, workflows.
    corpus_names = [f for f in repo.own_files if re.search(
        r"(^|/)(package\.json|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|requirements[^/]*\.txt|Pipfile|go\.mod|Cargo\.toml|\.coveragerc|"
        r"jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|\.nycrc(\.json)?|\.c8rc(\.json)?|stryker\.conf[^/]*|Makefile)$", f)
        or f.startswith(".github/workflows/")]
    corpus = [(f, text_of(f) or "") for f in corpus_names]
    code_ext = r"\.(py|[cm]?[jt]sx?|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|feature)$"
    own = [f for f in repo.own_files if not f.startswith("docs/")]
    test_files = [f for f in own if re.search(code_ext, f) and re.search(
        r"(^|/)(tests?|__tests__|test_[^/]*\.py|[^/]*_test\.(py|go)|[^/]*\.(test|spec)\.[cm]?[jt]sx?)($|/)", f)]
    rust_sources = [f for f in own if f.endswith(".rs")]
    test_corpus = [(f, text_of(f) or "") for f in test_files[:400] + rust_sources[:200]]

    # Workflows
    workflows = [f for f in repo.files if re.match(r"\.github/workflows/[^/]+\.ya?ml$", f)]
    wf_infos = {}
    code_of = {}
    for wf in workflows:
        text = text_of(wf)
        if text is not None:
            code_of[wf] = "\n".join(_strip_comment(l) for l in text.splitlines())
        if text is None:
            gaps.append(gap(f"workflow-unreadable:{wf}", f"Workflow {wf} could not be read", "S5.1 (F-003 SR-8)", "security",
                            SEVERITY_BLOCKS["medium"], "Make the workflow a readable text file under 1 MB so it can be checked.",
                            "onboarding-pr", [ev(wf)], "medium"))
            continue
        info = scan_workflow(text)
        wf_infos[wf] = info
        missing = [j for j, d in info["jobs"].items() if d["permissions"] is None]
        if info["top_permissions"] is None and (missing or not info["jobs"]):
            missing = missing or ["(no jobs found)"]
            gaps.append(gap(f"workflow-permissions:{wf}", f"Workflow {wf} does not declare permissions", "S8.3", "security",
                            SEVERITY_BLOCKS["medium"],
                            "Add `permissions: contents: read` at the top and grant more only to the jobs that need it.",
                            "onboarding-pr", [ev(wf, 1, "jobs without permissions: " + ", ".join(missing))], "medium"))
        unpinned = {}
        for n, ref in info["uses"]:
            if not action_pinned(ref):
                unpinned.setdefault(ref.partition("@")[0], []).append(ev(wf, n, ref))
        for name, evidence in unpinned.items():
            owner = name.split("/", 1)[0]
            sev = "low" if owner in ("actions", "github") else "medium"
            gaps.append(gap(f"action-unpinned:{wf}:{name}", f"Action {name} is not pinned to a commit SHA",
                            "S4.3", "security", SEVERITY_BLOCKS[sev],
                            "Pin to the full 40-character commit SHA of the release, with the tag in a comment.",
                            "onboarding-pr", evidence, sev))
        if info.get("write_all"):
            gaps.append(gap(f"workflow-write-all:{wf}", f"Workflow {wf} grants write-all permissions", "S8.3", "security",
                            SEVERITY_BLOCKS["medium"], "Grant only the scopes each job needs.", "onboarding-pr",
                            [ev(wf, info["write_all"])], "medium"))
        if info.get("pr_target"):
            gaps.append(gap(f"workflow-pr-target:{wf}", f"Workflow {wf} runs on pull_request_target", "S8.3; S6.1", "security",
                            SEVERITY_BLOCKS["high"],
                            "Use pull_request, or make sure the job never checks out or runs code from the PR.",
                            "onboarding-pr", [ev(wf, info["pr_target"])], "high"))

    # Secrets: report file, line and type only, never the value (SR-3).
    secret_counts = {}
    skipped = 0
    skipped_files = []
    for rel in repo.files:
        try:
            text = text_of(rel) if rel in texts_cache else repo.read(rel)
        except (OSError, CheckError):
            text = None
        if text is None:
            skipped += 1
            skipped_files.append(rel)
            continue
        is_env = bool(re.search(r"(^|/)\.env(\.[^/]*)?$", rel)) and not rel.endswith((".example", ".sample", ".template"))
        for n, line in enumerate(text.splitlines(), 1):
            rules = SECRET_RULES + ([("env-secret", ENV_SECRET)] if is_env else [])
            for kind, rx in rules:
                if rx.search(line):
                    key = (rel, kind)
                    secret_counts[key] = secret_counts.get(key, 0) + 1
                    gaps.append(gap(f"secret:{kind}:{rel}:{secret_counts[key]}", f"Possible {kind} committed in {rel}",
                                    "S3.1", "security", SEVERITY_BLOCKS["critical"],
                                    "Revoke and rotate the credential, then remove it from the file and from Git history.",
                                    "decision", [ev(rel, n, kind)], "critical"))
    in_repo = [f for f in repo.files + repo.symlinks if f == ".factory" or f.startswith(".factory/")]
    if in_repo:
        gaps.append(gap("factory:dir-in-repo", "`.factory/` is part of the repo's own files", "ADR 0009; S1.4", "security",
                        "rapid-prototype", "Remove it from the branch: `.factory/` is the git-ignored factory/state worktree, "
                        "and the factory won't trust records the repo itself carries.", "onboarding-pr",
                        [ev(f) for f in in_repo[:20]], "high"))
    for link in repo.symlinks:
        gaps.append(gap(f"symlink-escape:{link}", f"Symlink {link} points outside the repo", "S1.4", "security", None,
                        "Remove the link or point it inside the repo; the checker does not follow it.", "feature-request",
                        [ev(link)], "low"))

    # Dependency audit (S4.4): present, covers dev dependencies, runs weekly.
    audit_wf = None
    audit_wfs = []
    for wf, info in wf_infos.items():
        body = code_of.get(wf, "")
        if any(re.search(p, body) for p in AUDIT_PATTERNS):
            audit_wf = wf
            audit_wfs.append(wf)
            if re.search(r"npm audit[^\n]*(--omit[= ]dev|--production|--only[= ]prod)", body):
                gaps.append(gap(f"cve-audit-dev-excluded:{wf}", "Dependency audit skips development dependencies", "S4.4",
                                "security", min_level("beta", SEVERITY_BLOCKS["medium"]),
                                "Audit all dependencies, dev tools included.", "onboarding-pr", [ev(wf)], "medium"))
    if audit_wf is None:
        gaps.append(gap("cve-audit-missing", "No dependency CVE audit in CI", "S4.4; ADR 0008", "security",
                        min_level("beta", SEVERITY_BLOCKS["medium"]),
                        "Add a CI step that checks every dependency, dev tools included, against CVE entries.",
                        "onboarding-pr", [ev(".github/workflows/", detail="no audit tool found")], "medium"))
    elif not any(weekly_or_more(c) for w in audit_wfs for c in wf_infos[w]["crons"]):
        gaps.append(gap("cve-audit-not-weekly", "Dependency audit does not run on a schedule", "S4.4", "security",
                        min_level("beta", SEVERITY_BLOCKS["medium"]),
                        "Run the audit weekly too, so a CVE published after a merge is still found.",
                        "onboarding-pr", [ev(w) for w in audit_wfs], "medium"))

    # Required CI jobs by level (ADR 0008). Matched by keyword, so the
    # evidence says which keywords were looked for.
    ci_text = "\n".join(code_of.values())

    # From Beta (owner, 2026-11-10): OSV-Scanner reads lock files only, so Go
    # and Rust repos also run their own scanner for what it can't see.
    present_stacks = {s["name"] for s in stacks}
    for stack, tool, pattern, why in STACK_AUDITS:
        if stack in present_stacks and not re.search(pattern, ci_text):
            gaps.append(gap(f"stack-audit:{stack}", f"No {tool} in CI for this {stack.title()} code",
                            "S4.4; owner decision 2026-11-10 (F-003-audit-tool-review.md)", "security", "beta",
                            f"Add the `{tool}` job from the factory CI template: {why}", "onboarding-pr",
                            [ev(".github/workflows/" if workflows else None, detail=f"no workflow runs {tool}")]))
    for job, first_level, patterns, resolution in CI_JOBS:
        if job == "dependency-audit":
            continue  # covered by the S4.4 gaps above
        if not any(re.search(p, ci_text, re.M | re.I) for p in patterns):
            gaps.append(gap(f"ci-job:{job}", f"CI has no {job.replace('-', ' ')} job", "ADR 0008; maturity-levels.md (Required CI jobs)",
                            "ci", first_level, f"Add a required `{job}` job to CI.", resolution,
                            [ev(".github/workflows/" if workflows else None, detail="no workflow mentions: " + ", ".join(patterns[:3]))]))

    # Tools and tests (testing-strategy.md).
    stack_names = sorted({s["name"] for s in stacks})
    has_framework = bool(test_files) or _search(corpus, [p for s in stack_names for p in TEST_TOOLS.get(s, [])])
    has_rust_tests = _search(test_corpus, TEST_TOOLS["rust"]) if "rust" in stack_names else None
    tool_checks = [
        ("test-framework", "rapid-prototype", bool(has_framework or has_rust_tests)),
        ("coverage", "rapid-prototype", bool(_search(corpus, COVERAGE_TOOLS))),
        ("property-testing", "alpha", bool(_search(corpus + test_corpus, PROPERTY_TOOLS))),
        ("fuzzing", "beta", bool(_search(corpus + test_corpus, FUZZ_TOOLS) or any(f.startswith("fuzz/") for f in own))),
        ("mutation", "production-ready", bool(_search(corpus, MUTATION_TOOLS))),
    ]
    for tool, first_level, present in tool_checks:
        if present:
            continue
        candidates = sorted({c for s in stack_names for c in TOOL_CANDIDATES[tool].get(s, [])})
        gaps.append(gap(f"tool:{tool}", f"No {tool.replace('-', ' ')} tool chosen", "testing-strategy.md (Tools); S4.1",
                        "testing", first_level,
                        "Choose a tool as an Architecture decision, after its S4.1 security review.", "decision",
                        [ev(detail="candidates: " + (", ".join(candidates) or "depends on stack"))]))

    def has_tests(pattern):
        return any(re.search(pattern, f, re.I) for f in own if re.search(code_ext, f))

    unit_present = bool(test_files) or bool(has_rust_tests)
    test_checks = [
        ("unit", "rapid-prototype", unit_present, "Unit tests on core logic"),
        ("acceptance", "alpha", has_tests(r"(^|/)(acceptance|e2e)(/|[._-])|\.feature$"), "A test for every acceptance criterion"),
        ("contract", "beta", has_tests(r"(^|/)contracts?(/|[._-]?tests?)|contract[._-]?test"), "Contract tests for every interface"),
        ("integration", "beta", has_tests(r"(^|/)integration(/|[._-])|integration[._-]?test"), "Integration tests"),
        ("performance", "release", has_tests(r"(^|/)(perf|performance|bench|benches|load)(/|[._-])|_bench|\.bench\."), "Performance or load tests against stated targets"),
    ]
    for kind, first_level, present, what in test_checks:
        if not present:
            gaps.append(gap(f"tests:{kind}", f"No {kind} tests found", "testing-strategy.md (Test types, Pass bars)", "testing",
                            first_level, f"{what}: request this as a feature so the test engineer writes them from the spec.",
                            "feature-request", [ev(detail="matched by file and folder names")]))

    # Factory setup in the repo.
    readme = [f for f in repo.files if re.fullmatch(r"README(\.[A-Za-z]+)?", f, re.I)]
    if not readme:
        gaps.append(gap("docs:purpose", "No README stating the repo's purpose", "maturity-levels.md (→ Prototype: purpose written down)",
                        "config", "rapid-prototype", "Add a README that says what the repo is for.", "feature-request",
                        [ev(detail="no README file at the repo root")]))
    gitignore = text_of(".gitignore") if repo.exists(".gitignore") else ""
    if not re.search(r"^/?\.factory/?\s*$", gitignore or "", re.M):
        gaps.append(gap("factory:gitignore", "`.factory/` is not git-ignored", "ADR 0009", "config", "rapid-prototype",
                        "Add `.factory/` to .gitignore.", "onboarding-pr", [ev(".gitignore")]))
    claude_md = text_of("CLAUDE.md") if repo.exists("CLAUDE.md") else ""
    if "<!-- software-factory:begin -->" not in (claude_md or ""):
        gaps.append(gap("factory:claude-md", "CLAUDE.md does not point to the factory's rules", "F-003 FR-5", "config",
                        "rapid-prototype", "Add the factory section to CLAUDE.md.", "onboarding-pr", [ev("CLAUDE.md")]))
    state = run_git(repo.root, "rev-parse", "--verify", "--quiet", "factory/state") or \
        run_git(repo.root, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/factory/state")
    if not state:
        gaps.append(gap("factory:state-branch", "No `factory/state` branch", "ADR 0009", "config", "rapid-prototype",
                        "Create the branch and its `.factory/` records.", "onboarding-step",
                        [ev(detail="no local or origin branch named factory/state")]))

    # Branch protection (ADR 0006): read from `gh api` output the skill saved.
    protection_status = "unknown"
    if github_protection is not None:
        protection_status, detail = _protection(github_protection)
        if protection_status != "ok":
            gaps.append(gap("github:branch-protection", "The default branch is not protected as ADR 0006 requires", "ADR 0006; ADR 0008",
                            "github", "rapid-prototype",
                            "Protect the default branch: require the owner's approving review and the level's CI checks.",
                            "owner-step", [ev(detail=detail)]))
    else:
        gaps.append(gap("github:branch-protection", "Branch protection on the default branch not checked", "ADR 0006; ADR 0008", "github",
                        "rapid-prototype", "Sign in to `gh` and re-run, or check it in the repo's settings.", "owner-step",
                        [ev(detail="no GitHub data given")]))

    gaps = redact(gaps)
    gaps.sort(key=lambda g: (LEVELS.index(g["blocks_level"]) if g["blocks_level"] else 99, g["id"]))
    ids = {g["id"] for g in gaps}
    if len(ids) != len(gaps):
        raise CheckError("duplicate gap ids")

    result = {
        "schema": SCHEMA,
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "repo": os.path.basename(repo.root),
        "commit": (run_git(repo.root, "rev-parse", "HEAD") or b"").decode().strip() or None,
        "stacks": stacks,
        "files_scanned": len(repo.files) - skipped,
        "files_skipped": skipped,
        "skipped_files": skipped_files[:200],
        "test_files_found": test_files[:50],
        "test_inventory": test_inventory(test_files, dict(test_corpus))[:500],
        "chosen_level": level,
        "github": {"branch_protection": protection_status},
        "gaps": gaps,
        "maturity": recommend_level(gaps, readme),
        "complexity": suggest_complexity(repo, stacks),
        "recommended_work": recommended_work(gaps),
        "baseline_request": baseline_request(os.path.basename(repo.root), test_files, dict(test_corpus), level),
    }
    if level:
        result["blocking_now"] = [g["id"] for g in gaps if g["blocks_level"] and LEVELS.index(g["blocks_level"]) <= LEVELS.index(level)]
    if previous is not None:
        if not isinstance(previous, dict) or not isinstance(previous.get("gaps"), list) or \
                not all(isinstance(g, dict) and isinstance(g.get("id"), str) for g in previous["gaps"]):
            raise CheckError("previous assessment is not a valid assessment file")
        prev_ids = {g["id"] for g in previous["gaps"]}
        result["since_previous"] = {
            "previous_generated_at": previous.get("generated_at"),
            "closed": sorted(prev_ids - ids),
            "opened": sorted(ids - prev_ids),
        }
    return result


def single_line(value):
    """Line breaks in repo-derived text become spaces, everywhere in a result.

    File names and other repo text end up in Markdown the agent reads and in
    inbox items; a line break there could start a heading that reads like an
    instruction (SR-1)."""
    if isinstance(value, str):
        return re.sub(r"[\r\n\x0b\x0c\x1c-\x1e\u0085\u2028\u2029]+", " ", value)
    if isinstance(value, list):
        return [single_line(v) for v in value]
    if isinstance(value, dict):
        return {single_line(k): single_line(v) for k, v in value.items()}
    return value


def redact(value):
    if isinstance(value, str):
        for kind, rx in SECRET_RULES:
            value = rx.sub(f"[redacted {kind}]", value)
        return value
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {redact(k): redact(v) for k, v in value.items()}
    return value


def _protection(data):
    if not isinstance(data, dict):
        return "unknown", "unreadable GitHub data"
    msg = str(data.get("message", ""))
    if "not protected" in msg.lower():
        return "missing", "branch not protected"
    if msg:
        return "unknown", f"GitHub said: {msg[:80]}"
    reviews = data.get("required_pull_request_reviews") or {}
    checks = data.get("required_status_checks") or {}
    problems = []
    if not reviews or int(reviews.get("required_approving_review_count", 0) or 0) < 1:
        problems.append("no required approving review")
    else:
        # Without these, the factory token could push after the owner approves and then merge.
        if not reviews.get("dismiss_stale_reviews"):
            problems.append("stale reviews not dismissed")
        if not reviews.get("require_last_push_approval"):
            problems.append("last push not required to be approved")
        # The machine account has Write, so its approval would otherwise satisfy
        # the review rule on owner-authored PRs (F-003 Gate 2 R2-10).
        if not reviews.get("require_code_owner_reviews"):
            problems.append("code owner review not required")
    if not (checks.get("contexts") or checks.get("checks")):
        problems.append("no required status checks")
    elif not checks.get("strict"):
        problems.append("branches not required to be up to date")
    return ("ok", "") if not problems else ("incomplete", "; ".join(problems))


EVIDENCE = {
    "rapid-prototype": [("purpose", "Purpose written down (README)")],
    "alpha": [
        ("tests:unit", "Unit tests on core logic"),
        ("tests:acceptance", "Acceptance criteria of core features tested"),
        ("gate2", "Gate 2 security review of the whole codebase (factory record needed)"),
        ("known-issues", "Known issues listed (factory record needed)"),
    ],
    "beta": [
        ("tests:contract", "Contract tests for every interface"),
        ("tests:integration", "Integration tests"),
        ("cve-audit", "Dependency CVE audit in CI"),
        ("docs", "User-facing docs and tester feedback channel (owner confirms)"),
    ],
    "release": [
        ("tests:performance", "Performance/load tests against stated targets"),
        ("clean-env", "Full regression on a clean environment; upgrade and rollback tested (factory record needed)"),
    ],
    "production-ready": [("prod", "Production-like tests, backup/restore, monitoring, runbook, owner sign-off (factory record needed)")],
}


def recommend_level(gaps, readme):
    ids = {g["id"] for g in gaps}
    levels = []
    recommended = "rapid-prototype"
    still_climbing = True
    for level in LEVELS:
        items = []
        for key, label in EVIDENCE[level]:
            if key == "purpose":
                met = bool(readme)
            elif key.startswith("tests:"):
                met = key not in ids
            elif key == "cve-audit":
                met = not ({"cve-audit-missing", "cve-audit-not-weekly"} & ids)
            else:
                met = False  # only the factory's own records can show these
            items.append({"evidence": label, "met": met})
        levels.append({"level": level, "evidence": items})
        if level != "rapid-prototype" and still_climbing and all(i["met"] for i in items):
            recommended = level
        elif level != "rapid-prototype":
            still_climbing = False
    return {
        "recommended": recommended,
        "criteria_status": "draft",  # maturity-levels.md promotion table is not approved yet
        "note": "Rapid prototype is the floor. Higher levels also need evidence only the factory produces "
                "(Gate 2 reports, CI history), so a newly onboarded repo starts low and is promoted with evidence.",
        "levels": levels,
    }


def suggest_complexity(repo, stacks):
    sources = [f for f in repo.files if re.search(r"\.(py|[cm]?[jt]sx?|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h)$", f)]
    n, kinds = len(sources), len({s["name"] for s in stacks})
    preset = "simple" if n <= 50 and kinds <= 1 else "complex" if n > 500 or kinds >= 3 else "moderate"
    return {"suggested": preset, "source_files": n, "stacks": kinds,
            "rule": "simple: <=50 source files and one stack; complex: >500 files or 3+ stacks; otherwise moderate"}


def classify_test(path, text):
    p = path.lower()
    if re.search(r"(^|/)(acceptance|e2e)(/|[._-])|\.feature$", p):
        return "acceptance"
    if re.search(r"(^|/)contracts?(/|[._-])|contract[._-]?test|pact", p):
        return "contract"
    if re.search(r"(^|/)integration(/|[._-])|integration[._-]?test", p):
        return "integration"
    if re.search(r"(^|/)(perf|performance|bench|benches|load)(/|[._-])|_bench|\.bench\.", p):
        return "performance"
    if any(re.search(pat, text or "", re.M) for pat in PROPERTY_TOOLS + FUZZ_TOOLS):
        return "stochastic"
    return "unit"


def test_inventory(test_files, texts):
    return [{"path": f, "type": classify_test(f, texts.get(f, ""))} for f in test_files]


def baseline_request(repo_name, test_files, texts, level):
    counts = {}
    for item in test_inventory(test_files, texts):
        counts[item["type"]] = counts.get(item["type"], 0) + 1
    found = ", ".join(f"{n} {t}" for t, n in sorted(counts.items())) or "no tests"
    return (f"Test baseline for {repo_name}: write acceptance criteria for the repo's existing behavior, map the "
            f"adopted tests ({found}) to them, and add the missing tests to reach the "
            f"{level or 'chosen'} testing bar in testing-strategy.md.")


def recommended_work(gaps):
    work = []
    for level in LEVELS:
        items = [g for g in gaps if g["blocks_level"] == level and g["resolution"] == "feature-request"]
        if items:
            work.append({"level": level, "requests": [{"gap": g["id"], "request": f"{g['title']}. {g['fix']}"} for g in items]})
    later = [g for g in gaps if g["blocks_level"] is None and g["resolution"] == "feature-request"]
    if later:
        work.append({"level": None, "requests": [{"gap": g["id"], "request": f"{g['title']}. {g['fix']}"} for g in later]})
    return work


def _md_cell(text):
    # Repo-controlled text (file names included) must stay inside its table
    # cell: no line breaks that could start a heading the agent then reads.
    return re.sub(r"[\r\n\x0b\x0c\x1c-\x1e\u0085\u2028\u2029]+", " ", str(text)).replace("|", "\\|")


def to_markdown(a):
    level_name = {l: l.replace("-", " ").capitalize() for l in LEVELS}
    out = [f"# Factory onboarding assessment: {a['repo']}", "",
           f"- **Generated:** {a['generated_at']}", f"- **Commit:** {a['commit'] or 'none'}",
           f"- **Stacks:** " + (", ".join(f"{s['name']} ({s['dir']})" for s in a["stacks"]) or "unknown"),
           f"- **Recommended starting level:** {level_name[a['maturity']['recommended']]} "
           f"(promotion criteria are {a['maturity']['criteria_status']})",
           f"- **Suggested complexity preset:** {a['complexity']['suggested']} ({a['complexity']['source_files']} source files)",
           f"- **Branch protection:** {a['github']['branch_protection']}",
           f"- **Files scanned:** {a['files_scanned']} (skipped as binary or over 1 MB: {a['files_skipped']})", ""]
    if "since_previous" in a:
        sp = a["since_previous"]
        out += ["## Since the last assessment", "",
                f"Closed: {', '.join(sp['closed']) or 'none'}  ", f"Opened: {', '.join(sp['opened']) or 'none'}", ""]
    out += ["## Gaps by the level they block", ""]
    groups = [(l, level_name[l]) for l in LEVELS] + [(None, "Not blocking (counts against promotion)")]
    for level, name in groups:
        items = [g for g in a["gaps"] if g["blocks_level"] == level]
        if not items:
            continue
        out += [f"### {name}", "", "| Gap | Rule | Severity | Evidence | Fix | Handled by |", "|---|---|---|---|---|---|"]
        for g in items:
            evid = "; ".join(" ".join(filter(None, [":".join(str(x) for x in (e.get("path"), e.get("line")) if x), e.get("detail")]))
                             for e in g["evidence"]) or "—"
            cells = [f"`{g['id']}` {g['title']}", g["rule"], g.get("severity", "—"), evid, g["fix"], g["resolution"]]
            out.append("| " + " | ".join(_md_cell(c) for c in cells) + " |")
        out.append("")
    out += ["## Existing tests (adopted in place)", ""]
    if a.get("test_inventory"):
        out += ["| File | Type |", "|---|---|"]
        out += ["| " + _md_cell("`" + t["path"].replace("`", "'") + "`") + " | " + _md_cell(t["type"]) + " |"
                for t in a["test_inventory"]]
    else:
        out.append("None found.")
    if a.get("baseline_request"):
        out += ["", f"**Test baseline request:** {a['baseline_request']}"]
    out += ["", "## Starting maturity evidence", ""]
    for lv in a["maturity"]["levels"]:
        out.append(f"- **{level_name[lv['level']]}:** " + "; ".join(("✓ " if i["met"] else "✗ ") + i["evidence"] for i in lv["evidence"]))
    out += ["", a["maturity"]["note"], "", "## Recommended work", ""]
    if not a["recommended_work"]:
        out.append("None.")
    for group in a["recommended_work"]:
        out.append(f"### {level_name.get(group['level'], 'Not blocking')}")
        out += [f"- {r['request']} (`{r['gap']}`)" for r in group["requests"]]
        out.append("")
    return "\n".join(single_line(line) for line in out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Manifest validation (Project manifest v1.0, proposals/0013)
# ---------------------------------------------------------------------------

def known_defaults(master):
    if master:
        skills = sorted(d for d in os.listdir(os.path.join(master, "skills")) if os.path.isfile(os.path.join(master, "skills", d, "SKILL.md")))
        agents = sorted(d for d in os.listdir(os.path.join(master, "agents")) if os.path.isfile(os.path.join(master, "agents", d, "AGENT.md")))
        return set(skills), set(agents)
    return set(DEFAULT_SKILLS), set(CORE_AGENTS) | set(SUPPORT_AGENTS)


def _inside(path):
    if not isinstance(path, str) or not path or os.path.isabs(path) or re.match(r"^[A-Za-z]:", path):
        return False
    return ".." not in re.split(r"[\\/]", path)


def validate_manifest(data, master=None):
    errors = []
    if not isinstance(data, dict):
        return ["manifest must be a mapping"]
    if data.get("schema") != "factory-project/1.0":
        errors.append("schema must be factory-project/1.0")
    if not isinstance(data.get("name"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", data.get("name") or ""):
        errors.append("name is required: lowercase letters, digits, '.', '_' or '-'")
    factory = data.get("factory")
    if not isinstance(factory, dict) or not factory.get("version"):
        errors.append("factory.version is required")
    repos = data.get("repos")
    repo_levels = []
    if not isinstance(repos, list) or not repos:
        errors.append("repos must list at least one repository")
    else:
        names = set()
        for i, r in enumerate(repos):
            if not isinstance(r, dict):
                errors.append(f"repos[{i}] must be a mapping")
                continue
            for key in ("name", "url", "maturity"):
                if not r.get(key):
                    errors.append(f"repos[{i}].{key} is required")
            if r.get("name") in names:
                errors.append(f"repos[{i}].name {r.get('name')!r} is listed twice")
            names.add(r.get("name"))
            if r.get("url") and not str(r["url"]).startswith("https://"):
                errors.append(f"repos[{i}].url must be https")
            if r.get("maturity") and r["maturity"] not in LEVELS:
                errors.append(f"repos[{i}].maturity must be one of {', '.join(LEVELS)}")
            elif r.get("maturity"):
                repo_levels.append(r["maturity"])
    maturity = data.get("maturity")
    if maturity not in LEVELS:
        errors.append(f"maturity must be one of {', '.join(LEVELS)}")
    elif repo_levels and LEVELS.index(maturity) > min(LEVELS.index(l) for l in repo_levels):
        errors.append("maturity may not exceed the lowest repo's maturity")
    if "complexity" in data and data["complexity"] not in COMPLEXITY:
        errors.append(f"complexity must be one of {', '.join(COMPLEXITY)}")

    skills, agents = known_defaults(master)
    for section, defaults in (("skills", skills), ("agents", agents)):
        block = data.get(section) or {}
        if not isinstance(block, dict):
            errors.append(f"{section} must be a mapping")
            continue
        for key in ("custom", "override", "exclude"):
            if block.get(key) is not None and not isinstance(block.get(key), list):
                errors.append(f"{section}.{key} must be a list")
        overridden = set()
        for i, item in enumerate(block.get("override") or []):
            if not isinstance(item, dict):
                errors.append(f"{section}.override[{i}] must be a mapping")
                continue
            name = item.get("name")
            overridden.add(name)
            if name not in defaults:
                errors.append(f"{section}.override: {name!r} is not a default in the pinned master")
            if not item.get("reason"):
                errors.append(f"{section}.override: {name!r} needs a reason")
            if not _inside(item.get("path")):
                errors.append(f"{section}.override: {name!r} path must stay inside the config repo")
            if name in PROTECTED and not re.fullmatch(r"D-\d{4,}", str(item.get("decision", ""))):
                errors.append(f"{section}.override: {name!r} is protected and needs an approved Security decision (decision: D-nnnn)")
        for i, item in enumerate(block.get("exclude") or []):
            if not isinstance(item, dict):
                errors.append(f"{section}.exclude[{i}] must be a mapping")
                continue
            name = item.get("name")
            if name in PROTECTED:
                errors.append(f"{section}.exclude: {name!r} is protected and can never be excluded")
            if name not in defaults:
                errors.append(f"{section}.exclude: {name!r} is not a default in the pinned master")
            if not item.get("reason"):
                errors.append(f"{section}.exclude: {name!r} needs a reason")
            if name in overridden:
                errors.append(f"{section}: {name!r} can't be both overridden and excluded")
        for i, item in enumerate(block.get("custom") or []):
            if not isinstance(item, dict) or not item.get("name") or not _inside(item.get("path")):
                errors.append(f"{section}.custom[{i}] needs a name and a path inside the config repo")
    standards = data.get("standards") or {}
    if isinstance(standards, dict):
        for k, v in standards.items():
            if not _inside(v):
                errors.append(f"standards.{k} path must stay inside the config repo")
    else:
        errors.append("standards must be a mapping")
    errors += validate_policy(data, agents)
    return errors


# Files no agent may write without an approved hygiene item (S6.3).
CHANGE_CONTROLLED = ["CLAUDE.md", "**/CLAUDE.md", "CLAUDE.local.md", "**/CLAUDE.local.md", ".claude/**", ".mcp.json",
                     ".github/**", ".gitignore", ".gitattributes", ".husky/**", ".pre-commit-config.yaml",
                     "lefthook.yml", "osv-scanner.toml", "agents/**", "skills/**", "plugins/**",
                     ".claude-plugin/**", "workflows/**", "**/.claude/**", ".envrc", "**/.envrc", ".git", ".git/**",
                     ".gitmodules", ".vscode/**", ".devcontainer/**"]
POLICY_KEYS = {"tools": {"allow"}, "read": {"allow", "deny"}, "write": {"allow", "deny"},
               "commands": {"allow"}, "network": {"allow"}}
AGENT_TOOLS = {"Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Skill"}
FILE_TOOLS = AGENT_TOOLS - {"WebFetch", "WebSearch"}
# Role policy v2.2: no agent reads these, whatever its allow list says. The
# channel file would let an agent answer the owner's interview (F-005 SR-14).
SECRET_FILES = ["**/.env", "**/.env.*", "**/.envrc", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.jks",
                "**/*.keystore", "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*", "**/.npmrc",
                "**/.pypirc", "**/.netrc", "**/.git-credentials", "**/*.tfvars", "**/credentials*.json",
                "**/*.tfstate", "**/*.tfstate.*", "**/.aws/credentials", "**/.docker/config.json", "**/*.ppk",
                "**/kubeconfig", "**/.kube/config", ".factory/engine.json", "**/.factory/engine.json"]


# Role policy commands are program names with any arguments, so a shell or
# interpreter would undo every read and write rule (Gate 2 re-review R2-1).
# Interpreter families match as prefixes (pythonw, luajit, nodemon); shells and
# awks as suffixes of the name without its version (ksh93, bash5.2, gawk).
SHELL_FAMILIES = re.compile(r"^(python|pypy|ipython|node|ruby|irb|perl|php|lua|tcl|rscript)|^(r|py)$")
SHELL_SUFFIXES = re.compile(r"(sh|awk)$")
# A guard rail, not the boundary: build and test tools run repo code by design
# (R2-1 stays with the owner). Wrappers that run any command count as shells.
SHELL_COMMANDS = {"busybox", "find", "npx", "uv", "uvx", "pipx", "toybox", "script", "expect", "watch", "nohup",
                  "timeout", "nice", "time", "parallel", "stdbuf", "setsid", "ionice", "taskset", "flock", "chroot",
                  "runuser", "unbuffer", "unshare", "nsenter", "pkexec", "systemd-run", "strace", "gdb", "cscript",
                  "wscript", "mshta", "bunx", "pnpx", "tsx", "ts-node", "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd", "env",
                  "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "osascript", "xargs",
                  "eval", "exec", "sudo", "su", "doas"}


def _escapes_worktree(glob):
    # Globs are relative to the worktree root; `..` or an absolute path would let
    # a rule like `.factory/../src/**` look like a factory-only write.
    # Role policy globs have one dialect (H-0046): literal segments, `*` within a
    # segment and `**` across segments. `?`, bracket classes, braces and extglobs
    # mean different things to different glob libraries, so they are refused
    # rather than interpreted. A segment that can still match `..` (`.*`, `*.`)
    # counts as `..`.
    if re.search(r"[?\[\]{}]|[@!+*]\(", glob):
        return True
    return glob.startswith(("/", "~")) or "\\" in glob or re.match(r"^[A-Za-z]:", glob) is not None \
        or any(seg not in ("*", "**") and fnmatch.fnmatchcase("..", seg) for seg in glob.split("/"))


# Host names only: an engine that trims entries or matches them as globs
# would read " *", "*.com" or "0.0.0.0/0" as open web access (F-005 Gate 2 #2).
_HOST_RE = re.compile(r"(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")


def _check_role(where, rule, errors):
    if not isinstance(rule, dict):
        errors.append(f"{where} must be a mapping")
        return
    for key, value in rule.items():
        if key not in POLICY_KEYS:
            errors.append(f"{where}.{key} is not a policy key (tools, read, write, commands, network)")
            continue
        if not isinstance(value, dict):
            errors.append(f"{where}.{key} must be a mapping")
            continue
        for sub, items in value.items():
            if sub not in POLICY_KEYS[key]:
                errors.append(f"{where}.{key}.{sub} is not allowed")
            elif not isinstance(items, list) or not all(isinstance(i, str) and i for i in items):
                errors.append(f"{where}.{key}.{sub} must be a list of strings")
            elif key in ("read", "write") and any(_escapes_worktree(i) for i in items):
                errors.append(f"{where}.{key}.{sub} has a path outside the worktree (absolute, `..` or `\\`) or outside the glob dialect (`?`, `[...]`, braces, extglobs)")
            elif key == "commands":
                names = {os.path.basename(i).lower().removesuffix(".exe") for i in items}
                # Versioned or suffixed names (`python3.12`, `bash5.2`, `busybox.static`) count as their family.
                def base(n):
                    return re.split(r"[-.\d]", n)[0]
                shells = sorted(n for n in names if {n, base(n)} & SHELL_COMMANDS or SHELL_FAMILIES.match(n)
                                or SHELL_SUFFIXES.search(base(n)))
                if shells:
                    errors.append(f"{where}.commands.allow has shells or interpreters, which bypass the policy: {', '.join(shells)}")
            elif key == "network":
                bad = sorted(i for i in items if i != "*" and not _HOST_RE.fullmatch(i))
                if bad:
                    errors.append(f"{where}.network.{sub} entries must be lower-case host names or exactly \"*\": "
                                  + ", ".join(repr(i) for i in bad))
                elif "*" in items and len(items) > 1:
                    errors.append(f"{where}.network.{sub} must be exactly [\"*\"] when it allows any host")
            elif key == "tools":
                unknown = sorted(set(items) - AGENT_TOOLS)
                if unknown:
                    errors.append(f"{where}.tools.allow has unknown tools: {', '.join(unknown)}")


def effective_policy(data, repo_name):
    """Project roles with one repo's overrides: its allow lists replace the project's, deny lists add up."""
    roles = json.loads(json.dumps(((data.get("policy") or {}).get("roles")) or {}))
    if repo_name is None:
        return roles
    repo = next((r for r in data.get("repos") or [] if isinstance(r, dict) and r.get("name") == repo_name), {})
    for role, rule in (((repo.get("policy") or {}).get("roles")) or {}).items():
        base = roles.setdefault(role, {})
        for key, value in (rule or {}).items():
            target = base.setdefault(key, {})
            if "allow" in value:
                target["allow"] = list(value["allow"])
            if "deny" in value:
                target["deny"] = sorted(set(target.get("deny", [])) | set(value["deny"]))
    return roles


def validate_policy(data, agents):
    errors = []
    policy = data.get("policy")
    if policy is None:
        return errors
    if not isinstance(policy, dict) or not isinstance(policy.get("roles"), dict):
        return ["policy.roles must be a mapping of role names"]
    custom = {a.get("name") for a in ((data.get("agents") or {}).get("custom") or []) if isinstance(a, dict)}
    known = set(agents) | set(CORE_AGENTS) | custom
    for role in CORE_AGENTS:
        if role not in policy["roles"]:
            errors.append(f"policy.roles.{role} is missing, so that agent could not run")
    for role, rule in policy["roles"].items():
        if role not in known:
            errors.append(f"policy.roles.{role} is not a known agent")
        _check_role(f"policy.roles.{role}", rule, errors)
    for i, repo in enumerate(data.get("repos") or []):
        if not isinstance(repo, dict) or repo.get("policy") is None:
            continue
        roles = repo["policy"].get("roles") if isinstance(repo["policy"], dict) else None
        if not isinstance(roles, dict):
            errors.append(f"repos[{i}].policy.roles must be a mapping")
            continue
        for role, rule in roles.items():
            if role not in policy["roles"]:
                errors.append(f"repos[{i}].policy.roles.{role} is not in the project policy")
            else:
                base = set(((policy["roles"][role] or {}).get("tools") or {}).get("allow") or [])
                wider = sorted(set((((rule or {}).get("tools") or {}).get("allow")) or []) - base)
                if wider:
                    errors.append(f"repos[{i}].policy.roles.{role}.tools adds {', '.join(wider)}; "
                                  "widening a role is a Security decision made in the project policy")
            _check_role(f"repos[{i}].policy.roles.{role}", rule, errors)
    if errors:
        return errors
    # Any role that can write outside the factory's own records must be denied change-controlled files.
    # The project policy is checked on its own too: it applies wherever a repo
    # has no override, and an override can hide a bad project rule (Gate 2 #10).
    for repo in [None, *(data.get("repos") or [])]:
        name = repo.get("name") if isinstance(repo, dict) else None
        where = f"repo {name}" if name else "the project"
        for role, rule in effective_policy(data, name).items():
            if not (rule.get("tools") or {}).get("allow"):
                errors.append(f"policy for {role} in {where} lists no tools, so that agent could not run")
            tools = set((rule.get("tools") or {}).get("allow") or [])
            if tools & FILE_TOOLS and not (rule.get("read") or {}).get("allow"):
                errors.append(f"policy for {role} in {where} allows no reads")
            # Open web content must never reach an agent that can see project files (F-005 SR-17).
            if "*" in ((rule.get("network") or {}).get("allow") or []) and tools & FILE_TOOLS:
                errors.append(f"policy for {role} in {where} allows any host but has file tools "
                              f"({', '.join(sorted(tools & FILE_TOOLS))}); only a WebFetch/WebSearch-only role may")
            missing = [f for f in SECRET_FILES if f not in set((rule.get("read") or {}).get("deny") or [])]
            if missing:
                errors.append(f"policy for {role} in {where} must deny reading {', '.join(missing)}")
            allow = (rule.get("write") or {}).get("allow") or []
            deny = set((rule.get("write") or {}).get("deny") or [])
            if any(not a.startswith(".factory/") for a in allow):
                missing = [c for c in CHANGE_CONTROLLED if c not in deny]
                if missing:
                    errors.append(f"policy for {role} in {where} must deny writes to {', '.join(missing)}")
    return sorted(set(errors))


# ---------------------------------------------------------------------------
# Decision items (Inbox item v1.0)
# ---------------------------------------------------------------------------

def _q(value):
    return json.dumps(value, ensure_ascii=False)


def existing_items(inbox_dir):
    filed, highest = {}, 0
    if not os.path.isdir(inbox_dir):
        return filed, highest
    for name in os.listdir(inbox_dir):
        m = re.fullmatch(r"(D-(\d{4,}))\.md", name)
        if not m:
            continue
        highest = max(highest, int(m.group(2)))
        if os.path.islink(os.path.join(inbox_dir, name)):
            continue
        with open(os.path.join(inbox_dir, name), encoding="utf-8", errors="replace") as f:
            text = f.read()
        front = text.split("\n---", 1)[0] if text.startswith("---") else ""
        for ref in re.findall(r"^\s+ref:\s*\"?[^\n\"]*#onboard:([^\s\"']+)", front, re.M):
            filed[ref] = m.group(1)
    return filed, highest


def planned_items(a, assessment_ref, include_complexity=False, level=None):
    items = []
    stack_names = sorted({s["name"] for s in a["stacks"]})
    rec = a["maturity"]["recommended"]
    items.append({
        "key": "maturity-start", "category": "Product", "priority": "high", "blocking": True,
        "title": f"Set the starting maturity level for {a['repo']}",
        "options": [{"id": chr(65 + i), "label": l} for i, l in enumerate(LEVELS)],
        "recommendation": chr(65 + LEVELS.index(rec)),
        "context": "Onboarding needs a starting level to choose the CI jobs and gate bars. "
                   f"The assessment recommends {rec}. The promotion criteria in maturity-levels.md are still draft.",
        "options_body": "\n".join(f"- **{chr(65 + i)}. {l}:** " + "; ".join(("met: " if e["met"] else "missing: ") + e["evidence"]
                                                                          for e in a["maturity"]["levels"][i]["evidence"])
                                  for i, l in enumerate(LEVELS)),
        "impact": "Sets which gaps block now and which CI jobs become required checks.",
        "cost": "Onboarding can't finish the CI workflow or the manifest entry without it.",
    })
    if include_complexity:
        c = a["complexity"]
        items.append({
            "key": "complexity", "category": "Product", "priority": "medium", "blocking": False,
            "title": "Set the project's complexity preset for initial calibration",
            "options": [{"id": chr(65 + i), "label": l} for i, l in enumerate(COMPLEXITY)],
            "recommendation": chr(65 + COMPLEXITY.index(c["suggested"])),
            "context": f"F-002 calibrates each agent's model and effort starting from this preset. Rule used: {c['rule']}.",
            "options_body": "\n".join(f"- **{chr(65 + i)}. {l}**" for i, l in enumerate(COMPLEXITY)),
            "impact": "Only the starting point for calibration; agents' settings are tuned from real runs afterwards.",
            "cost": "Calibration waits for it.",
        })
    for g in a["gaps"]:
        if g["id"].startswith("tool:"):
            if level and LEVELS.index(g["blocks_level"]) > LEVELS.index(level):
                continue
            tool = g["id"].split(":", 1)[1]
            candidates = sorted({c for s in stack_names for c in TOOL_CANDIDATES[tool].get(s, [])}) or ["(depends on stack)"]
            items.append({
                "key": g["id"], "category": "Architecture", "priority": "high" if g["blocks_level"] == "rapid-prototype" else "medium",
                "blocking": g["blocks_level"] == "rapid-prototype",
                "title": f"Choose a {tool.replace('-', ' ')} tool for {a['repo']}",
                "options": [{"id": chr(65 + i), "label": c} for i, c in enumerate(candidates)],
                "recommendation": "A",
                "context": f"The testing bar from {g['blocks_level']} needs a {tool.replace('-', ' ')} tool. "
                           "Each candidate is untrusted until its S4.1 review is filled in below.",
                "options_body": "\n".join(f"- **{chr(65 + i)}. {c}**" for i, c in enumerate(candidates)) +
                                "\n\n### S4.1 review\n\n#### Source and maintainers\nTo be filled before recommending.\n\n"
                                "#### Known CVEs and fixes\nTo be filled.\n\n#### Install scripts\nTo be filled.\n\n"
                                "#### Permissions needed\nTo be filled.\n\n#### What it pulls in\nTo be filled.",
                "impact": "Becomes the project's tool for this test type, and an approved external component.",
                "cost": f"Blocks the {g['blocks_level']} testing bar.",
            })
        elif g["category"] == "security" and g.get("severity") in ("critical", "high"):
            e = g["evidence"][0] if g["evidence"] else {}
            items.append({
                "key": g["id"], "category": "Security", "priority": g["severity"], "blocking": True,
                "title": g["title"],
                "options": [{"id": "A", "label": "Rotate the credential and purge it from history"},
                            {"id": "B", "label": "Rotate the credential and keep history"}]
                if g["id"].startswith("secret:") else [{"id": "A", "label": "Fix as recommended"}, {"id": "B", "label": "Accept the risk"}],
                "recommendation": "A",
                "context": f"{g['rule']}: found at {e.get('path', '?')}" + (f" line {e['line']}" if e.get("line") else "") +
                           ". The value is not copied here.",
                "options_body": f"- **A.** {g['fix']}\n- **B.** " + (
                    "Rotate it now and leave the dead value in history. Cheaper, but the old value stays readable to anyone with the repo."
                    if g["id"].startswith("secret:") else "Record it as a known issue; it keeps blocking from the level above."),
                "impact": f"Blocks every level from {g['blocks_level']}.",
                "cost": "The exposure stays open until it is handled.",
            })
    for it in items:
        it["link"] = f"{assessment_ref}#onboard:{it['key']}"
    return items


def render_item(item, item_id, now):
    lines = ["---", "schema: inbox-item/1.0", f"id: {item_id}", "inbox: decision", f"title: {_q(item['title'])}",
             f"category: {item['category']}", f"priority: {item['priority']}", f"effective_priority: {item['priority']}",
             f"blocking: {'true' if item['blocking'] else 'false'}", "status: open", "created_by: orchestrator",
             f"created_at: {now}", "options:"]
    for o in item["options"]:
        lines += [f"  - id: {o['id']}", f"    label: {_q(o['label'])}"]
    lines += [f"recommendation: {item['recommendation']}", "links:", "  - kind: file", f"    ref: {_q(item['link'])}",
              "history:", f"  - at: {now}", "    by: orchestrator", "    action: filed", "---", "",
              "## Context", "", item["context"], "", "## Options", "", item["options_body"], "",
              "## Project impact", "", item["impact"], "", "## Recommendation", "",
              f"Option {item['recommendation']}.", "", "## Cost of delay", "", item["cost"], ""]
    return "\n".join(lines)


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def plan_items(a, inbox_dir, assessment_ref, include_complexity=False, write=False, now=None, level=None):
    now = now or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    a = dict(a, gaps=single_line(a.get("gaps") or []))
    filed, highest = existing_items(inbox_dir)
    created, skipped = [], []
    for item in planned_items(a, assessment_ref, include_complexity, level):
        if item["key"] in filed:
            skipped.append({"key": item["key"], "id": filed[item["key"]]})
            continue
        highest += 1
        item_id = f"D-{highest:04d}"
        if write:
            atomic_write(os.path.join(inbox_dir, f"{item_id}.md"), render_item(item, item_id, now))
        created.append({"key": item["key"], "id": item_id, "category": item["category"], "title": item["title"]})
    return {"created": created, "already_filed": skipped}


# ---------------------------------------------------------------------------

PLUGIN_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".claude-plugin", "plugin.json")


def plugin_version(manifest=None, plugin_json=PLUGIN_JSON):
    """The installed plugin's release tag, and whether the manifest pins that tag.

    The marketplace serves whatever ref the owner added it at, so the skill
    checks that the copy it runs from is the factory version the project
    pinned (F-003 Gate 2 R2-8).
    """
    with open(plugin_json, encoding="utf-8") as f:
        version = json.load(f).get("version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise CheckError("the installed plugin has no X.Y.Z version")
    result = {"version": version, "tag": f"v{version}"}
    if manifest is not None:
        with open(manifest, encoding="utf-8") as f:
            data = parse_yaml(f.read())
        factory = data.get("factory") if isinstance(data, dict) else None
        pinned = factory.get("version") if isinstance(factory, dict) else None
        result["pinned"] = pinned if isinstance(pinned, str) else None
        result["match"] = result["pinned"] == result["tag"]
    return result


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _require_state_worktree(inbox_dir):
    """A repo can carry its own `.factory/` with forged items marked as filed,
    or a `.factory` link pointing elsewhere; only the factory/state worktree's
    inbox is trusted (Gate 2 R3-2, R3-3, R4-1, R4-2). A folder outside any git
    work tree and outside any `.factory` is a plain folder chosen by the caller."""
    full = os.path.abspath(inbox_dir)
    parts = full.split(os.sep)
    if ".factory" not in parts:
        probe = os.path.realpath(full)
        while not os.path.isdir(probe) and os.path.dirname(probe) != probe:
            probe = os.path.dirname(probe)
        if run_git(probe, "rev-parse", "--is-inside-work-tree") is None:
            return
        branch = run_git(probe, "symbolic-ref", "--short", "HEAD")
        if branch is None or branch.decode().strip() != "factory/state":
            raise CheckError(f"inbox folder is not in the factory/state worktree: {inbox_dir}")
        return
    k = len(parts) - 1 - parts[::-1].index(".factory")
    factory = os.sep.join(parts[:k + 1]) or os.sep
    repo = os.path.dirname(factory)
    fail = f"inbox folder is not in the factory/state worktree at {factory}"
    if os.path.islink(factory) or not os.path.isdir(factory):
        raise CheckError(fail)

    def git(where, *args):
        out = run_git(where, *args)
        return os.path.realpath(out.decode().strip()) if out is not None else None
    branch = run_git(factory, "symbolic-ref", "--short", "HEAD")
    if git(factory, "rev-parse", "--show-toplevel") != os.path.realpath(factory) \
            or branch is None or branch.decode().strip() != "factory/state" \
            or git(repo, "rev-parse", "--show-toplevel") != os.path.realpath(repo) \
            or git(factory, "rev-parse", "--path-format=absolute", "--git-common-dir") \
            != git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"):
        raise CheckError(fail)


def _through_symlink(path):
    """True if a folder from the current directory down to path is a symlink.

    Folders above the current directory (macOS /tmp, /var) are the system's
    business and don't count."""
    full = os.path.abspath(path)
    base = os.path.abspath(os.getcwd())
    if os.path.commonpath([full, base]) != base:
        base = os.path.dirname(os.path.dirname(full))
    probe = base
    for part in os.path.relpath(full, base).split(os.sep):
        probe = os.path.join(probe, part)
        if os.path.islink(probe):
            return True
    return False


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("assess")
    a.add_argument("repo")
    a.add_argument("--out-json")
    a.add_argument("--out-md")
    a.add_argument("--github-protection", help="file holding `gh api repos/O/R/branches/main/protection` output")
    a.add_argument("--previous", help="previous assessment JSON, to list gaps closed and opened")
    a.add_argument("--level", choices=LEVELS, help="the repo's chosen level, to list what blocks now")
    m = sub.add_parser("validate-manifest")
    m.add_argument("manifest")
    m.add_argument("--master", help="master factory checkout, to check override/exclude names")
    i = sub.add_parser("plan-items")
    i.add_argument("assessment")
    i.add_argument("--inbox-dir", required=True)
    i.add_argument("--assessment-ref", required=True, help="path of the assessment on factory/state, used in item links")
    i.add_argument("--complexity", action="store_true", help="also file the complexity preset decision (new project)")
    i.add_argument("--write", action="store_true", help="write the items; without it, only print the plan")
    i.add_argument("--level", choices=LEVELS, help="file tool decisions only for levels up to this one")
    v = sub.add_parser("plugin-version")
    v.add_argument("--manifest", help="factory-project.yaml whose factory.version must be this plugin's tag")
    args = p.parse_args(argv)

    try:
        if args.cmd == "assess":
            gh = None
            if args.github_protection:
                try:
                    gh = _load_json(args.github_protection)
                except (OSError, json.JSONDecodeError):
                    gh = "unreadable"
            prev = _load_json(args.previous) if args.previous else None
            result = assess(args.repo, gh, prev, args.level)
            if args.out_json:
                atomic_write(args.out_json, json.dumps(result, indent=2) + "\n")
            if args.out_md:
                atomic_write(args.out_md, to_markdown(result))
            if not args.out_json and not args.out_md:
                print(json.dumps(result, indent=2))
            else:
                print(f"{len(result['gaps'])} gaps; recommended level {result['maturity']['recommended']}")
            return 0
        if args.cmd == "validate-manifest":
            try:
                with open(args.manifest, encoding="utf-8") as f:
                    data = parse_yaml(f.read())
            except UnicodeDecodeError as e:
                raise CheckError("manifest is not UTF-8") from e
            except RecursionError as e:
                raise CheckError("manifest is nested too deeply") from e
            errors = validate_manifest(data, args.master)
            print("\n".join(errors) or "Manifest is valid.")
            return 1 if errors else 0
        if args.cmd == "plugin-version":
            result = plugin_version(args.manifest)
            print(json.dumps(result, indent=2))
            return 1 if result.get("match") is False else 0
        if args.cmd == "plan-items":
            if args.write and _through_symlink(args.inbox_dir):
                raise CheckError(f"inbox folder goes through a symlink, refusing to write: {args.inbox_dir}")
            _require_state_worktree(args.inbox_dir)
        if args.cmd == "plan-items":
            result = plan_items(_load_json(args.assessment), args.inbox_dir, args.assessment_ref, args.complexity, args.write,
                                level=args.level)
            print(json.dumps(result, indent=2))
            return 0
    except (CheckError, OSError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
