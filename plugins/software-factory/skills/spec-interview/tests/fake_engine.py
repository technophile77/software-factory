"""A fake engine for the client's developer tests: Engine control channel
v1.1 (with H-0025) plus v1.3's advisor items (H-0063 as amended by H-0075)
over a Unix socket, one JSON-RPC 2.0 message per line. v1.2's GitHub
approval of a session (H-0051) is modelled only as far as the client sees
it: `open` carries `approval` when one is set, and `awaitApproval` answers
from `approval_result`.

It keeps just enough state to exercise the client: sessions by token with
the per-feature lock and takeover, item revisions, the error codes, reply
ids recorded once, each deferred item once per session, `interview.next`
waiting up to `wait_s` for research, reply kinds checked against item kinds,
and advisor calls whose advice entries go from running to done or failed.
Switches on the instance make it misbehave on purpose.
"""
import copy
import json
import os
import secrets
import socket
import tempfile
import threading
import time

BUSY, STALE, UNKNOWN, SESSION, KIND = -32001, -32002, -32003, -32004, -32005
STARTED_AT = "2026-11-10T09:00:00Z"


def item(iid, text="Which database?", kind="question", status="open", revision=1, **extra):
    return {"id": iid, "revision": revision, "kind": kind, "text": text,
            "why": "It decides the schema.", "status": status, **extra}


def proposal(iid, about, revision=1, status="open", **extra):
    return item(iid, text=f"Ask the advisor about {about}?", kind="advisor_proposal", status=status,
                revision=revision, about=about, why="It cuts across three ADRs.", **extra)


# v1.3: which reply kinds each item kind takes; anything else is -32005.
KINDS = {"question": {"answer", "more_info", "defer", "ask_advisor"},
         "assumption": {"approve_assumption", "reject_assumption"},
         "advisor_proposal": {"approve_advisor", "decline_advisor"}}
NEW_STATUS = {"answer": "answered", "defer": "deferred", "more_info": "researching",
              "approve_assumption": "approved", "reject_assumption": "rejected",
              "approve_advisor": "approved", "decline_advisor": "rejected"}


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


class FakeEngine:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="sf-eng-")
        os.chmod(self.dir, 0o700)
        self.path = os.path.join(self.dir, "engine.sock")
        self.features = {}            # id -> {"title": str, "items": [item]}
        self.calls = []               # (connection number, method, params)
        self.connections = 0
        self.sessions = {}            # token -> {"feature", "shown"}
        self.locks = {}               # feature -> token
        self.replies = {}             # reply_id -> result
        self.started = []
        self.lock = threading.Lock()
        # Misbehaviour switches
        self.drop_after_reply = False
        self.ready_after = None       # seconds until more_info research finishes
        self.ready_findings = [{"text": "Postgres is used elsewhere.", "source": "docs/adr/0002.md"}]
        self.advisor_calls = []       # (call id, question id): every advisor session started
        self.advice_after = None      # seconds until a call finishes; None leaves it running
        self.advice_result = {"status": "done", "text": "Findings\n- Postgres is in ADR 0002 (source: docs/adr/0002.md)",
                              "web_queries": ["postgres vs sqlite embedded"]}
        self.raw_response = None      # bytes sent instead of any answer
        self.error_data = None
        self.silent = False
        self.notify_first = False     # send a notification before each answer
        self.approval = None          # the `approval` object `open` returns, if any
        self.approval_result = True   # True approves; an RpcError code fails awaitApproval
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path)
        self.srv.listen(8)
        threading.Thread(target=self._accept, daemon=True).start()

    def close(self):
        # shutdown wakes the accept() thread; close alone leaves it listening on Linux.
        try:
            self.srv.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.srv.close()

    def methods(self):
        return [m for _, m, _ in self.calls]

    def open_session(self, feature):
        """Opens a session as another client would, without a connection."""
        token = secrets.token_hex(16)
        self.sessions[token] = {"feature": feature, "shown": set()}
        self.locks[feature] = token
        return token

    def _accept(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            with self.lock:
                self.connections += 1
                n = self.connections
            threading.Thread(target=self._serve, args=(conn, n), daemon=True).start()

    def _serve(self, conn, n):
        f = conn.makefile("rwb")
        try:
            for line in f:
                msg = json.loads(line)
                with self.lock:
                    self.calls.append((n, msg["method"], msg.get("params")))
                if self.silent:
                    continue
                if self.raw_response is not None:
                    f.write(self.raw_response)
                    f.flush()
                    continue
                try:
                    result, drop = self._dispatch(msg["method"], msg.get("params") or {})
                    reply = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
                except RpcError as e:
                    err = {"code": e.code, "message": e.message}
                    data = self.error_data if self.error_data is not None else e.data
                    if data is not None:
                        err["data"] = data
                    reply, drop = {"jsonrpc": "2.0", "id": msg["id"], "error": err}, False
                if drop:
                    break
                if self.notify_first:
                    f.write(b'{"jsonrpc":"2.0","method":"feature.stageChanged","params":{"feature":"F-001"}}\n')
                f.write(json.dumps(reply).encode() + b"\n")
                f.flush()
        except (OSError, ValueError):
            pass
        finally:
            try:
                f.close()
                conn.close()
            except OSError:
                pass

    def _find(self, feature, iid):
        for it in self.features[feature]["items"]:
            if it["id"] == iid:
                return it
        raise RpcError(UNKNOWN, "unknown item")

    def _session(self, token):
        s = self.sessions.get(token)
        if s is None or self.locks.get(s["feature"]) != token:
            raise RpcError(SESSION, "unknown or expired session")
        return s

    def _pick(self, s):
        items = self.features[s["feature"]]["items"]
        for it in items:
            if it["status"] == "deferred" and it["id"] not in s["shown"]:
                s["shown"].add(it["id"])
                return it
        for status in ("open", "researching"):
            for it in items:
                if it["status"] == status:
                    return it
        return None

    def _next(self, s, wait_s=0):
        deadline = time.monotonic() + wait_s
        while True:
            with self.lock:
                it = self._pick(s)
            if it is None or it["status"] != "researching" or time.monotonic() >= deadline:
                return copy.deepcopy(it)
            time.sleep(0.05)

    def _dispatch(self, method, params):
        if method == "engine.status":
            return {"version": "1.3.0", "uptime_s": 5, "features": []}, False
        if method == "feature.start":
            self.started.append(params["request"])
            return {"feature": "F-100"}, False
        if method == "interview.list":
            return {"features": [
                {"id": fid, "title": f["title"],
                 "open": sum(i["status"] == "open" for i in f["items"] if i["kind"] == "question"),
                 "deferred": sum(i["status"] == "deferred" for i in f["items"]),
                 "pending_assumptions": sum(i["status"] == "open" for i in f["items"] if i["kind"] == "assumption")}
                for fid, f in self.features.items()]}, False
        if method == "interview.open":
            feature = params.get("feature")
            if feature not in self.features:
                raise RpcError(UNKNOWN, "unknown feature")
            with self.lock:
                if feature in self.locks and not params.get("takeover"):
                    raise RpcError(BUSY, "another session is open for this feature", {"started_at": STARTED_AT})
                token = self.open_session(feature)
            out = {"session": token, "started_at": STARTED_AT}
            if self.approval is not None:
                out["approval"] = self.approval
            return out, False
        if method == "interview.state":
            feature = params.get("feature")
            if feature not in self.features:
                raise RpcError(UNKNOWN, "unknown feature")
            it = self._find(feature, params["item"])
            out = {"status": it["status"], "revision": it["revision"]}
            if "recorded_at" in it:
                out["recorded_at"] = it["recorded_at"]
            return out, False
        s = self._session(params.get("session"))
        if method == "interview.awaitApproval":
            if self.approval_result is True:
                return {"approved": True}, False
            raise RpcError(self.approval_result, "approval did not complete")
        if method == "interview.next":
            return {"item": self._next(s, min(params.get("wait_s", 0), 600))}, False
        if method == "interview.close":
            del self.locks[s["feature"]]
            return {"ok": True}, False
        if method == "interview.reply":
            return self._reply(s, params)
        raise RpcError(-32601, "method not found")

    def _reply(self, s, p):
        if p["reply_id"] in self.replies:
            return self.replies[p["reply_id"]], False
        it = self._find(s["feature"], p["item"])
        if p["revision"] != it["revision"]:
            raise RpcError(STALE, "stale: the item has changed")
        if p["kind"] not in KINDS[it["kind"]]:
            raise RpcError(KIND, "reply kind does not fit the item")
        if it["kind"] == "advisor_proposal" and it["status"] != "open":
            raise RpcError(STALE, "stale: the proposal was already decided")
        target = None
        if p["kind"] == "ask_advisor":
            target = it
        elif p["kind"] == "approve_advisor":
            target = self._find(s["feature"], it["about"])
        it.setdefault("replies", []).append(p)
        it["recorded_at"] = "2026-11-10T10:00:00Z"
        # ask_advisor leaves the question as it was: it stays open while the advisor works.
        it["status"] = NEW_STATUS.get(p["kind"], it["status"])
        if target is not None:
            self._start_call(target)
        if p["kind"] == "defer":
            s["shown"].add(it["id"])
        if p["kind"] == "more_info":
            result = {"status": "researching"}
            if self.ready_after is not None:
                threading.Timer(self.ready_after, self._research_done, (it,)).start()
        else:
            with self.lock:
                result = {"status": it["status"], "next": copy.deepcopy(self._pick(s))}
        self.replies[p["reply_id"]] = result
        return result, self.drop_after_reply

    def _start_call(self, question):
        with self.lock:
            call = f"A-{len(self.advisor_calls) + 1:04d}"
            self.advisor_calls.append((call, question["id"]))
            question.setdefault("advice", []).append({"call": call, "status": "running",
                                                      "revision": question["revision"]})
        if self.advice_after is not None:
            threading.Timer(self.advice_after, self.finish_call, (call,)).start()

    def finish_call(self, call, **result):
        """Ends an advisor call with `result`, or with advice_result."""
        with self.lock:
            for f in self.features.values():
                for it in f["items"]:
                    for a in it.get("advice", []):
                        if a["call"] == call:
                            asked = a.get("revision")
                            a.clear()
                            a.update({"call": call, "revision": asked, **copy.deepcopy(result or self.advice_result)})

    def _research_done(self, it):
        with self.lock:
            it["revision"] += 1
            it["status"] = "open"
            it["findings"] = self.ready_findings
