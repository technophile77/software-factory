"""SR-13 checks for the master factory repo (H-0088).

The master repo is cloned by every owner, so it must never carry one owner's
own values. Run from the repo root; it reads tracked files only.

1. The project paths file is never tracked.
2. In templates and test fixtures, owner keys hold a `<...>` placeholder, a
   value built by code, or one of the example values listed here.
3. Nowhere is there an OAuth client id or an email address that could be real.
4. The model endpoints file is never tracked, and no file outside the allow
   list holds a private address or a `.local` host (H-0137, F-013 AC-1).
"""
import re
import subprocess
import sys

PATHS_FILE = "factory-projects.local.yaml"
ENDPOINTS_FILE = "factory-endpoints.local.yaml"
UNTRACKED_FILES = {PATHS_FILE, ENDPOINTS_FILE}
# This check's own tests hold made-up bad values on purpose.
SKIP = {"scripts/tests/test_check_placeholders.py", "scripts/tests/test_check_endpoint_addresses.py"}

# H-0137 (F-013 AC-1): no tracked file carries an owner's endpoint address.
# Paths here document address ranges or use made-up addresses as test
# fixtures; a trailing "/" would allow everything under a directory, so the
# engine entries name the files that need it instead: a new file holding an
# address fails CI until a reviewer adds it here. Each entry was checked
# against the tree when it was added.
ADDRESS_ALLOWED = (
    "engine/src/proxy/main.ts",  # subnet doc example (docker bridge addresses)
    "engine/src/proxy/rules.ts",  # blocked-range CIDR tables
    "engine/src/config/endpoint-address.ts",  # private-range tables and classification doc examples
    "engine/test/acceptance/containers-real.test.ts",  # docker bridge addresses the real-container checks expect
    "engine/test/agent.test.ts",  # fake docker subnets
    "engine/test/endpoint-address.test.ts",  # classifier cases, including the refused ranges
    "engine/test/endpoints.test.ts",  # endpoint file fixtures with made-up LAN addresses
    "engine/test/fakes.ts",  # fake docker's network subnets and container addresses
    "engine/test/litellm.test.ts",  # router config fixtures with made-up LAN addresses
    "engine/test/proxy.test.ts",  # fixtures that prove the proxy refuses private ranges
    "docs/features/F-007-test-plan.md",  # AC-15 lists the refused addresses
    "docs/features/F-007-test-report.md",  # reports the same AC-15 run
    "docs/features/F-007-security-gate1.md",  # finding 3 names a private address the web reader must refuse
)

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


_OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
# RFC 1918: 10/8, 172.16/12, 192.168/16. Not part of a longer dotted number.
PRIVATE_IPV4 = re.compile(
    r"(?<![\w.])(?:10\.%s\.%s\.%s|172\.(?:1[6-9]|2\d|3[01])\.%s\.%s|192\.168\.%s\.%s)(?![\w]|\.\d)"
    % ((_OCTET,) * 7)
)
# The ULA block is the prefixes fc and fd; the colon requirement keeps hex hashes out.
ULA_IPV6 = re.compile(r"(?<![0-9A-Fa-f:.])f[cd][0-9a-f]{2}(?::[0-9a-f]{0,4}){1,7}(?![0-9a-f])", re.I)
# A name ending in .local used as a host: after "://" or "@", or followed by a
# port or a path. Bare dotted identifiers (`providers.local: true`) and file
# names (`.local.yaml`, `.local.md`) are not hosts.
_LOCAL_NAME = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.local"
LOCAL_HOST = re.compile(
    r"(?:(?:://|@)%s(?![\w-]|\.\w))|(?:(?<![\w.-])%s(?::\d+|/))" % (_LOCAL_NAME, _LOCAL_NAME), re.I
)


def address_allowed(path):
    return any(path.startswith(a) if a.endswith("/") else path == a for a in ADDRESS_ALLOWED)


def check_addresses(path, text):
    """Report lines of a tracked file that hold an owner endpoint address (H-0137)."""
    if address_allowed(path):
        return []
    errors = []
    for n, line in enumerate(text.splitlines(), 1):
        if PRIVATE_IPV4.search(line) or ULA_IPV6.search(line) or LOCAL_HOST.search(line):
            errors.append(f"{path}:{n}: private address or .local host; endpoint addresses belong in {ENDPOINTS_FILE} (F-013 AC-1)")
    return errors


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
        name = path.split("/")[-1]
        if name == PATHS_FILE:
            errors.append(f"{path}: the project paths file must never be tracked (SR-13)")
            continue
        if name == ENDPOINTS_FILE:
            errors.append(f"{path}: the model endpoints file must never be tracked (F-013 AC-1)")
            continue
        if path in SKIP:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        errors.extend(check_text(path, text))
        errors.extend(check_addresses(path, text))
    for e in errors:
        print(e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
