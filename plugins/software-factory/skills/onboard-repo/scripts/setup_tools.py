#!/usr/bin/env python3
"""Sets up the onboard-repo checker's tools (ADR 0020, F-003 FR-12).

Standard library only, since it runs before the tools exist. It installs
PyYAML and zizmor from `requirements-tools.txt` with pip's hash checking into
a virtual environment, and gitleaks from its official release, checked
against `gitleaks-pins.json`. On success it prints the environment's Python,
which then runs factory_check.py. A finished environment is reused; anything
that doesn't match its pins is refused and nothing is used.

Usage: python3 -I setup_tools.py [--home DIR] [--gitleaks PATH]
  --gitleaks  an existing gitleaks binary (the engine's, say) to copy instead
              of downloading; its SHA-256 must still match the pin.
Exit codes: 0 ready, 1 failed (the reason is on stderr).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS = os.path.join(HERE, "requirements-tools.txt")
GITLEAKS_PINS = os.path.join(HERE, "gitleaks-pins.json")
MIN_PYTHON = (3, 11)
ZIZMOR_VERSION = "1.32.0"
MAX_ARCHIVE = 64 * 1024 * 1024
WINDOWS = sys.platform == "win32"


class SetupError(Exception):
    pass


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def platform_key() -> str:
    os_name = {"linux": "linux", "darwin": "darwin", "win32": "win32"}.get(sys.platform)
    cpu = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
    if not os_name or not cpu:
        raise SetupError(f"no pinned tools for {sys.platform} on {platform.machine()}")
    return f"{os_name}-{cpu}"


def default_home() -> str:
    if WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
    elif sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Caches")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "software-factory", "onboard-repo-tools")


def env_paths(env_dir: str) -> dict:
    scripts = os.path.join(env_dir, "Scripts" if WINDOWS else "bin")
    exe = ".exe" if WINDOWS else ""
    return {
        "python": os.path.join(scripts, "python" + exe),
        "zizmor": os.path.join(scripts, "zizmor" + exe),
        "gitleaks": os.path.join(env_dir, "sf-bin", "gitleaks" + exe),
    }


def env_key(pins: dict) -> str:
    """Names the environment after everything that decides its contents, so a
    new pin or Python version gets a fresh one instead of patching the old."""
    with open(REQUIREMENTS, "rb") as f:
        req = f.read()
    blob = req + json.dumps(pins, sort_keys=True).encode() + f"{sys.version_info[0]}.{sys.version_info[1]}".encode()
    return sha256_of(blob)[:16]


def run(args, timeout=600):
    # Fixed argument lists, no shell (F-003 SR-6), and none of the caller's
    # pip settings: only the hashes in requirements-tools.txt decide.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("PIP_", "PYTHON"))}
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env, check=False)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise SetupError(f"{os.path.basename(args[0])} failed: {tail}")
    return proc.stdout


def check_gitleaks(binary: str, pin: dict, version: str) -> None:
    if sha256_file(binary) != pin["binary_sha256"]:
        raise SetupError("gitleaks binary does not match its pinned SHA-256")
    out = run([binary, "version"], timeout=30).strip()
    if out.lstrip("v") != version:
        raise SetupError(f"gitleaks reports version {out!r}, expected {version}")


def check_zizmor(binary: str) -> None:
    out = run([binary, "--version"], timeout=30).strip()
    if out != f"zizmor {ZIZMOR_VERSION}":
        raise SetupError(f"zizmor reports {out!r}, expected {ZIZMOR_VERSION}")


def extract_gitleaks(archive: bytes, asset: str) -> bytes:
    """Only the one regular file named gitleaks; nothing else in the archive is written."""
    want = "gitleaks.exe" if asset.endswith(".zip") else "gitleaks"
    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            members = [m for m in z.infolist() if m.filename == want and not m.is_dir()]
            if len(members) != 1:
                raise SetupError("gitleaks archive does not hold exactly one gitleaks binary")
            return z.read(members[0])
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as t:
        members = [m for m in t.getmembers() if m.name == want]
        if len(members) != 1 or not members[0].isreg():
            raise SetupError("gitleaks archive does not hold exactly one gitleaks binary")
        f = t.extractfile(members[0])
        return f.read() if f else b""


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:  # https only; urllib checks the certificate
        data = r.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        raise SetupError("gitleaks download is larger than expected")
    return data


def install_gitleaks(dest: str, pins: dict, key: str, source: str | None, fetcher=fetch) -> None:
    pin = pins["platforms"].get(key)
    if pin is None:
        raise SetupError(f"no pinned gitleaks for {key}")
    if source:
        with open(source, "rb") as f:
            binary = f.read()
    else:
        url = pins["url"] + pin["asset"]
        if not url.startswith("https://github.com/gitleaks/gitleaks/releases/download/"):
            raise SetupError("gitleaks pin names an unexpected download address")
        archive = fetcher(url)
        if sha256_of(archive) != pin["archive_sha256"]:
            raise SetupError("gitleaks download does not match its pinned SHA-256")
        binary = extract_gitleaks(archive, pin["asset"])
    if sha256_of(binary) != pin["binary_sha256"]:
        raise SetupError("gitleaks binary does not match its pinned SHA-256")
    os.makedirs(os.path.dirname(dest), mode=0o700, exist_ok=True)
    with open(dest, "wb") as f:
        f.write(binary)
    os.chmod(dest, stat.S_IRWXU)
    check_gitleaks(dest, pin, pins["version"])


def ready(env_dir: str, pins: dict, key: str) -> bool:
    paths = env_paths(env_dir)
    if not os.path.isfile(os.path.join(env_dir, "sf-ready.json")):
        return False
    try:
        check_gitleaks(paths["gitleaks"], pins["platforms"][key], pins["version"])
        check_zizmor(paths["zizmor"])
    except (SetupError, OSError, KeyError, subprocess.TimeoutExpired):
        return False
    return True


def setup(home: str, gitleaks_source: str | None = None, fetcher=fetch) -> str:
    if sys.version_info < MIN_PYTHON:
        raise SetupError("the onboard-repo checker needs Python 3.11 or later (F-003 FR-12)")
    with open(GITLEAKS_PINS, encoding="utf-8") as f:
        pins = json.load(f)
    key = platform_key()
    os.makedirs(home, mode=0o700, exist_ok=True)
    env_dir = os.path.join(home, "env-" + env_key(pins))
    if ready(env_dir, pins, key):
        return env_paths(env_dir)["python"]

    # Built beside the final folder and renamed into place, so a half-made
    # environment is never mistaken for a ready one.
    work = tempfile.mkdtemp(prefix="build-", dir=home)
    try:
        run([sys.executable, "-I", "-m", "venv", work])
        paths = env_paths(work)
        run([paths["python"], "-I", "-m", "pip", "install", "--require-hashes", "--only-binary", ":all:",
             "--no-deps", "--no-input", "--isolated", "-r", REQUIREMENTS])
        check_zizmor(paths["zizmor"])
        install_gitleaks(paths["gitleaks"], pins, key, gitleaks_source, fetcher)
        with open(os.path.join(work, "sf-ready.json"), "w", encoding="utf-8") as f:
            json.dump({"key": os.path.basename(env_dir), "platform": key}, f)
        shutil.rmtree(env_dir, ignore_errors=True)
        os.replace(work, env_dir)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    # venv records its own folder in a few scripts; the interpreter and the
    # tools we call by path don't depend on it, so the rename is safe.
    return env_paths(env_dir)["python"]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Set up the onboard-repo checker's pinned tools.")
    p.add_argument("--home", default=None, help="where the tool environments live")
    p.add_argument("--gitleaks", default=None, help="copy this gitleaks binary instead of downloading it")
    a = p.parse_args(argv)
    try:
        python = setup(a.home or default_home(), a.gitleaks)
    except (SetupError, OSError, subprocess.TimeoutExpired, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(python)
    return 0


if __name__ == "__main__":
    sys.exit(main())
