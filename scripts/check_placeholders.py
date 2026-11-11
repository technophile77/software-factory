"""SR-13 checks for the master factory repo (H-0088).

The master repo is cloned by every owner, so it must never carry one owner's
own values. Run from the repo root; it reads tracked files only.

1. The project paths file is never tracked.
2. In templates and test fixtures, owner keys hold a `<...>` placeholder, a
   value built by code, or one of the example values listed here.
3. Nowhere is there an OAuth client id or an email address that could be real.
"""
import re
import subprocess
import sys

PATHS_FILE = "factory-projects.local.yaml"
# This check's own tests hold made-up bad values on purpose.
SKIP = {"scripts/tests/test_check_placeholders.py"}

# Literal example values the tests use. A new test value goes here, so a
# reviewer sees it was made up rather than pasted from a real account.
EXAMPLE_IDS = {"0", "-5", "678", "1001", "3003", "6666", "12345", "424242", "1000001", "7777777"}
EXAMPLE_CLIENT_IDS = {"", "other", "Iv1.example", "Iv1.someoneelse", "Iv1.placeholder0001"}
EXAMPLE_LOGINS = {"intruder", "org0", "example-owner", "example-org", "acme"}

OWNER_KEY = re.compile(r"\b(github_id|oauth_client_id)\s*:\s*(\"[^\"]*\"|'[^']*'|[^\s,}\)\"'`]+)")
REPO_OWNER = re.compile(r"\{\s*login:\s*([^,\s}]+)\s*,\s*id:\s*([^\s}]+)\s*\}")
CONSTANT = re.compile(r"\b(?:OWNER_ID|CLIENT_ID)\s*=\s*(\"[^\"]*\"|'[^']*'|[^;\s]+)")

CLIENT_ID_SHAPE = re.compile(r"\bIv1\.[0-9a-f]{16}\b|\bOv23li[A-Za-z0-9]{14}\b")
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b")
EMAIL_DOMAINS_OK = re.compile(r"^(?:.*\.)?(?:example\.(?:com|org|net)|[A-Za-z0-9.-]*\.(?:invalid|example)|github\.com)$", re.I)


def is_fixture(path):
    parts = path.split("/")
    return (
        "templates" in parts[:-1]
        or any(p in ("test", "tests", "fixtures") for p in parts[:-1])
        or "fixture" in parts[-1].lower()
    )


def unquote(v):
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" else v


CODE_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$|^[a-z_]\w*\.[\w.]+$")


def built_by_code(v):
    # A placeholder, template interpolation, a regex in a replace() call, a
    # backreference, or a constant or property the test defines elsewhere.
    return v.startswith("<") or "${" in v or "\\" in v or "$1" in v or bool(CODE_NAME.match(v))


def check_text(path, text):
    errors = []
    lines = text.splitlines()
    if is_fixture(path):
        for n, line in enumerate(lines, 1):
            for key, raw in OWNER_KEY.findall(line):
                v = unquote(raw)
                if built_by_code(v):
                    continue
                ok = EXAMPLE_IDS if key == "github_id" else EXAMPLE_CLIENT_IDS
                if "/templates/" in f"/{path}" or v not in ok:
                    errors.append(f"{path}:{n}: {key} is not a placeholder or a listed example value")
            for login, ident in REPO_OWNER.findall(line):
                login, ident = unquote(login), unquote(ident)
                if not built_by_code(login) and login not in EXAMPLE_LOGINS:
                    errors.append(f"{path}:{n}: repo owner login is not a placeholder or a listed example value")
                if not built_by_code(ident) and ident not in EXAMPLE_IDS:
                    errors.append(f"{path}:{n}: repo owner id is not a placeholder or a listed example value")
            for raw in CONSTANT.findall(line):
                v = unquote(raw)
                if not built_by_code(v) and v not in EXAMPLE_IDS | EXAMPLE_CLIENT_IDS:
                    errors.append(f"{path}:{n}: owner constant is not a listed example value")
    for n, line in enumerate(lines, 1):
        if CLIENT_ID_SHAPE.search(line):
            errors.append(f"{path}:{n}: looks like a real OAuth client id")
        for m in EMAIL.finditer(line):
            local = m.group(0).split("@", 1)[0].lower()
            if local != "noreply" and not EMAIL_DOMAINS_OK.match(m.group(1)):
                errors.append(f"{path}:{n}: email address outside the example domains")
    return errors


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], check=True, capture_output=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def main():
    errors = []
    for path in tracked_files():
        if path.split("/")[-1] == PATHS_FILE:
            errors.append(f"{path}: the project paths file must never be tracked (SR-13)")
            continue
        if path in SKIP:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        errors.extend(check_text(path, text))
    for e in errors:
        print(e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
