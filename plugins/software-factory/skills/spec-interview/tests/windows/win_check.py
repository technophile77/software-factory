"""First real Windows run of the interview client (F-005 SR-7, Gate 2 #9,
validation n5). Runs the real Win32 pipe calls against stand-in engines and
writes win_check_report.json and .md next to this file. Every check runs even
if an earlier one fails; nothing here changes the client.

Usage (Windows, from anywhere): python win_check.py
"""
import importlib.util
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
SKILL = os.path.dirname(TESTS)
CLIENT = os.path.join(SKILL, "scripts", "interview_client.py")
PY_ENGINE = os.path.join(HERE, "pipe_engine.py")
NODE_ENGINE = os.path.join(HERE, "node_engine.js")
QUESTION = "Which database — Postgres or SQLite? ✓ 数据库 \U0001f600"
ANSWER = "Postgres — café ✓ 数据库 \U0001f44d"
GIT = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"]

results = []


def check(cid, title):
    def wrap(fn):
        t0 = time.monotonic()
        try:
            detail = fn()
            outcome = "PASS"
        except Skip as e:
            outcome, detail = "SKIP", str(e)
        except AssertionError as e:
            outcome, detail = "FAIL", str(e)
        except Exception:  # noqa: BLE001
            outcome, detail = "ERROR", traceback.format_exc(limit=6)
        results.append({"id": cid, "title": title, "outcome": outcome,
                        "detail": detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False),
                        "seconds": round(time.monotonic() - t0, 2)})
        print(f"{outcome:5} {cid} {title}", flush=True)
        return fn
    return wrap


class Skip(Exception):
    pass


def load_client():
    spec = importlib.util.spec_from_file_location("interview_client", CLIENT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pipe_name():
    return "\\\\.\\pipe\\sf-wincheck-" + secrets.token_hex(8)


class Engine:
    def __init__(self, argv):
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        line = []
        t = threading.Thread(target=lambda: line.append(self.proc.stdout.readline()), daemon=True)
        t.start()
        t.join(20)
        if not line or b"READY" not in line[0]:
            self.stop()
            err = self.proc.stderr.read().decode("utf-8", "replace")[-2000:]
            raise AssertionError(f"stand-in engine did not start: {err}")

    def stop(self):
        try:
            self.proc.kill()
            self.proc.wait(10)
        except Exception:  # noqa: BLE001
            pass


def py_engine(name, mode="normal"):
    return Engine([sys.executable, PY_ENGINE, name, mode])


def make_repo():
    """A repo whose .factory is its factory/state worktree, as onboarding leaves it."""
    root = tempfile.mkdtemp(prefix="sf-wincheck-")
    repo = os.path.join(root, "repo")
    os.mkdir(repo)
    run = lambda *a, cwd=repo: subprocess.run(GIT + list(a), cwd=cwd, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    with open(os.path.join(repo, "README.md"), "w") as f:
        f.write("x\n")
    run("add", "README.md")
    run("commit", "-q", "-m", "init")
    run("branch", "factory/state")
    run("worktree", "add", "-q", ".factory", "factory/state")
    return root, repo


def write_engine_json(repo, path, pid):
    with open(os.path.join(repo, ".factory", "engine.json"), "w", encoding="utf-8") as f:
        json.dump({"version": "1.1", "path": path, "pid": pid}, f)


def cli(repo, sub, req, python=None):
    """Runs the client as SKILL.md does: -I, request on stdin, stdout piped."""
    p = subprocess.run([python or sys.executable, "-I", CLIENT, sub], input=json.dumps(req).encode("utf-8"),
                       capture_output=True, cwd=repo, timeout=200)
    try:
        text = p.stdout.decode("utf-8")
    except UnicodeDecodeError as e:
        raise AssertionError(f"{sub}: stdout is not UTF-8 ({e}); stderr={p.stderr[-800:]!r} "
                             f"stdout(cp1252)={p.stdout.decode('cp1252', 'replace')[:300]!r}")
    try:
        out = json.loads(text)
    except ValueError:
        raise AssertionError(f"{sub}: exit {p.returncode}, stdout is not JSON: {text[-600:]!r} "
                             f"stderr={p.stderr.decode('utf-8', 'replace')[-1500:]!r}")
    return p.returncode, out


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------------------

@check("C01", "Environment")
def c01():
    info = {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
            "stdout_encoding_when_piped": subprocess.run(
                [sys.executable, "-I", "-c", "import sys; print(sys.stdout.encoding)"],
                capture_output=True).stdout.decode().strip(),
            "preferred_encoding": __import__("locale").getpreferredencoding(False),
            "git": subprocess.run(["git", "--version"], capture_output=True).stdout.decode().strip(),
            "node": (subprocess.run(["node", "--version"], capture_output=True).stdout.decode().strip()
                     if shutil.which("node") else None),
            "python3_on_path": shutil.which("python3"), "py_launcher": shutil.which("py")}
    need(os.name == "nt", "not running on Windows")
    return info


@check("C02", "The client's Win32 bindings load (ctypes kernel32/advapi32)")
def c02():
    ic = load_client()
    ic._Win32Pipe()
    return "ok"


@check("C03", "No engine on the pipe: engine_unreachable, nothing hangs")
def c03():
    ic = load_client()
    try:
        ic._PipeTransport(pipe_name())
    except ic.ChannelError as e:
        need(e.code == "engine_unreachable", f"code {e.code}")
        return e.message
    raise AssertionError("connected to a pipe nobody created")


@check("C04", "Real pipe round trip, Python stand-in: status, list, open, next, reply, close")
def c04():
    ic = load_client()
    name = pipe_name()
    eng = py_engine(name)
    try:
        t = ic._PipeTransport(name)
        need(t.api.server_is_owner(t.handle), "server_is_owner false for our own engine")
        ch = ic.Channel(t)
        log = {"status": ch.call("engine.status")}
        log["list"] = ch.call("interview.list")
        need(log["list"]["features"][0]["title"] == "Café export — déjà vu", "title mangled")
        tok = ch.call("interview.open", {"feature": "F-001"})["session"]
        item = ch.call("interview.next", {"session": tok})["item"]
        need(item["text"] == QUESTION, f"question text mangled: {item['text']!r}")
        r = ch.call("interview.reply", {"session": tok, "item": "Q1", "revision": 1, "reply_id": "r1",
                                        "kind": "answer", "text": ANSWER})
        need(r["status"] == "answered", f"reply status {r}")
        ch.call("interview.close", {"session": tok})
        t.close()
        return log
    finally:
        eng.stop()


@check("C05", "Answer near the 1 MiB limit arrives whole (many partial reads)")
def c05():
    ic = load_client()
    name = pipe_name()
    eng = py_engine(name, "big")
    try:
        ch = ic.Channel(ic._PipeTransport(name))
        tok = ch.call("interview.open", {"feature": "F-001"})["session"]
        t0 = time.monotonic()
        item = ch.call("interview.next", {"session": tok})["item"]
        need(len(item["text"]) == 1024 * 1024 - 400, f"got {len(item['text'])} chars")
        return f"{len(item['text'])} chars in {time.monotonic() - t0:.2f} s"
    finally:
        eng.stop()


@check("C06", "Request near the 1 MiB limit is written whole (partial writes)")
def c06():
    ic = load_client()
    name = pipe_name()
    eng = py_engine(name)
    try:
        ch = ic.Channel(ic._PipeTransport(name))
        tok = ch.call("interview.open", {"feature": "F-001"})["session"]
        big = "A" * (1024 * 1024 - 1000)
        r = ch.call("interview.reply", {"session": tok, "item": "Q1", "revision": 1, "reply_id": "r2",
                                        "kind": "answer", "text": big})
        need(r["status"] == "answered", str(r))
        return "ok"
    finally:
        eng.stop()


@check("C07", "Silent engine: the call times out on time and never blocks (SR-15, validation M5)")
def c07():
    ic = load_client()
    ic.TIMEOUT = 3.0
    name = pipe_name()
    eng = py_engine(name, "silent")
    try:
        ch = ic.Channel(ic._PipeTransport(name))
        t0 = time.monotonic()
        try:
            ch.call("engine.status")
        except ic.ChannelError as e:
            took = time.monotonic() - t0
            need(e.code == "timeout", f"code {e.code}")
            need(took < 8, f"took {took:.1f} s for a 3 s limit")
            return f"timeout after {took:.2f} s"
        raise AssertionError("a silent engine answered")
    finally:
        eng.stop()


@check("C08", "Engine closes the pipe mid-call: connection_lost")
def c08():
    ic = load_client()
    name = pipe_name()
    eng = py_engine(name, "drop")
    try:
        ch = ic.Channel(ic._PipeTransport(name))
        try:
            ch.call("engine.status")
        except ic.ChannelError as e:
            need(e.code == "connection_lost", f"code {e.code}: {e.message}")
            need(e.sent, "sent flag not set")
            return e.message
        raise AssertionError("no error")
    finally:
        eng.stop()


@check("C09", "End to end as SKILL.md runs it (python -I, stdin JSON, piped stdout, engine.json in factory/state)")
def c09():
    root, repo = make_repo()
    name = pipe_name()
    eng = py_engine(name)
    steps = {}
    try:
        write_engine_json(repo, name, eng.proc.pid)
        rc, out = cli(repo, "status", {})
        steps["status"] = rc
        need(rc == 0 and out["ok"], f"status: {out}")
        rc, out = cli(repo, "list", {})
        steps["list"] = rc
        need(rc == 0 and "déjà" in out["display"], f"list: {out}")
        rc, out = cli(repo, "open", {"feature": "F-001"})
        need(rc == 0, f"open: {out}")
        tok = out["session"]
        rc, out = cli(repo, "next", {"session": tok})
        steps["next"] = rc
        need(rc == 0 and QUESTION in out["display"], f"next: question not shown intact: {out}")
        rc, out = cli(repo, "reply", {"session": tok, "feature": "F-001", "item": "Q1", "revision": 1,
                                      "status": "open", "kind": "answer", "text": ANSWER})
        steps["reply"] = rc
        need(rc == 0 and out["status"] == "answered", f"reply: {out}")
        rc, out = cli(repo, "close", {"session": tok})
        steps["close"] = rc
        need(rc == 0, f"close: {out}")
        return steps
    finally:
        eng.stop()
        shutil.rmtree(root, ignore_errors=True)


@check("C10", "engine.json names a pid that isn't the pipe's server (contract: clients check it)")
def c10():
    root, repo = make_repo()
    name = pipe_name()
    eng = py_engine(name)
    try:
        write_engine_json(repo, name, os.getpid())
        rc, out = cli(repo, "status", {})
        need(rc != 0, "the client talked to a pipe whose server is not the pid in engine.json")
        return out
    finally:
        eng.stop()
        shutil.rmtree(root, ignore_errors=True)


@check("C11", "Engine not running (no engine.json): refused with engine_not_running")
def c11():
    root, repo = make_repo()
    try:
        rc, out = cli(repo, "status", {})
        need(rc == 2 and out["error"]["code"] == "engine_not_running", str(out))
        return out["display"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


@check("C12", "engine.json committed on factory/state: refused (git ls-files on Windows)")
def c12():
    root, repo = make_repo()
    try:
        write_engine_json(repo, "\\\\.\\pipe\\x", 1)
        fac = os.path.join(repo, ".factory")
        subprocess.run(GIT + ["add", "engine.json"], cwd=fac, check=True, capture_output=True)
        subprocess.run(GIT + ["commit", "-q", "-m", "x"], cwd=fac, check=True, capture_output=True)
        rc, out = cli(repo, "status", {})
        need(rc == 2 and out["error"]["code"] == "bad_engine_file", str(out))
        return out["display"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def git_bash():
    env = os.environ.get("CLAUDE_CODE_GIT_BASH_PATH")
    if env and os.path.isfile(env):
        return env
    # git.exe sits in Git\cmd, Git\bin or Git\mingw64\bin depending on the installer.
    git = shutil.which("git")
    base = os.path.dirname(git) if git else None
    for _ in range(3):
        if not base:
            break
        base = os.path.dirname(base)
        for cand in (os.path.join(base, "bin", "bash.exe"), os.path.join(base, "usr", "bin", "bash.exe")):
            if os.path.isfile(cand):
                return cand
    for cand in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"):
        if os.path.isfile(cand):
            return cand
    return None


@check("C13", "Through Git Bash with the heredoc, as SKILL.md writes the command (python3, else python as it says for Windows)")
def c13():
    bash = git_bash()
    if not bash:
        raise Skip("Git Bash not found")
    root, repo = make_repo()
    name = pipe_name()
    eng = py_engine(name)
    try:
        write_engine_json(repo, name, eng.proc.pid)
        script = os.path.join(root, "run.sh")
        with open(script, "w", newline="\n") as f:
            f.write('cd "$1" || exit 9\n'
                    'PY=python3; command -v python3 >/dev/null || PY=python\n'
                    'echo "python3=$(command -v python3) using=$PY"\n'
                    '"$PY" --version 2>&1\n'
                    '"$PY" -I "$2" list <<\'SF_REQUEST_END\'\n{}\nSF_REQUEST_END\n'
                    'echo "exit=$?"\n')
        p = subprocess.run([bash, script, repo.replace("\\", "/"), CLIENT.replace("\\", "/")],
                           capture_output=True, timeout=120)
        out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
        need('"ok": true' in out and "exit=0" in out and "d\u00e9j\u00e0" in out, f"bash={bash}\n{out[-2000:]}")
        return f"bash={bash}\n{out[-800:]}"
    finally:
        eng.stop()
        shutil.rmtree(root, ignore_errors=True)


@check("C14", "End to end against a Node named-pipe server (libuv, as the real engine will be)")
def c14():
    node = shutil.which("node")
    if not node:
        raise Skip("node not on PATH")
    root, repo = make_repo()
    name = pipe_name()
    eng = Engine([node, NODE_ENGINE, name])
    try:
        write_engine_json(repo, name, eng.proc.pid)
        rc, out = cli(repo, "status", {})
        need(rc == 0, f"status: {out}")
        rc, out = cli(repo, "open", {"feature": "F-002"})
        need(rc == 0, f"open: {out}")
        tok = out["session"]
        rc, out = cli(repo, "next", {"session": tok})
        need(rc == 0 and "Redis or SQS? ✓" in out["display"], f"next: {out}")
        rc, out = cli(repo, "reply", {"session": tok, "feature": "F-002", "item": "Q1", "revision": 1,
                                      "status": "open", "kind": "answer", "text": ANSWER})
        need(rc == 0 and out["status"] == "answered", f"reply: {out}")
        rc, out = cli(repo, "close", {"session": tok})
        need(rc == 0, f"close: {out}")
        return "ok"
    finally:
        eng.stop()
        shutil.rmtree(root, ignore_errors=True)


@check("C15", "Existing developer and acceptance suites on Windows (information only)")
def c15():
    out = {}
    for pattern in ("test_interview_client.py", "test_acceptance.py"):
        p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", TESTS, "-p", pattern],
                           capture_output=True, timeout=900)
        tail = p.stderr.decode("utf-8", "replace").strip().splitlines()[-4:]
        out[pattern] = {"exit": p.returncode, "tail": tail}
    return out


def write_report():
    with open(os.path.join(HERE, "win_check_report.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    lines = ["# Windows check of the interview client", "",
             f"Run {time.strftime('%Y-%m-%d %H:%M:%S')} on {platform.platform()}, Python {platform.python_version()}", "",
             "| Check | Result | Seconds |", "|---|---|---|"]
    lines += [f"| {r['id']} {r['title']} | {r['outcome']} | {r['seconds']} |" for r in results]
    lines += ["", "## Details", ""]
    for r in results:
        lines += [f"### {r['id']} {r['outcome']}", "", "```", r["detail"][:4000], "```", ""]
    with open(os.path.join(HERE, "win_check_report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    write_report()
    bad = [r for r in results if r["outcome"] in ("FAIL", "ERROR")]
    print(f"\n{len(results)} checks, {len(bad)} failed. Report: {os.path.join(HERE, 'win_check_report.md')}")
    sys.exit(1 if bad else 0)
