"""A fake engine for the client's developer tests: Engine control channel
v1.1 over a Unix socket, newline-delimited JSON-RPC 2.0.

It keeps just enough state to exercise the client: the per-feature session
lock bound to a connection, item revisions, `stale`, `busy`, reply ids
recorded once, deferred items first, and `interview.itemReady` after
`more_info`. Switches on the instance make it misbehave on purpose.
"""
import copy
import json
import os
import socket
import tempfile
import threading
import time

BUSY, STALE, UNKNOWN = -32010, -32011, -32012


def item(iid, text="Which database?", kind="question", status="open", revision=1, **extra):
    return {"id": iid, "revision": revision, "kind": kind, "text": text,
            "why": "It decides the schema.", "status": status, **extra}


class FakeEngine:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="sf-eng-")
        os.chmod(self.dir, 0o700)
        self.path = os.path.join(self.dir, "engine.sock")
        self.features = {}            # id -> {"title": str, "items": [item]}
        self.calls = []               # (connection number, method, params)
        self.connections = 0
        self.locks = {}               # feature -> (connection, started)
        self.replies = {}             # reply_id -> result
        self.started = []
        self.lock = threading.Lock()
        # Misbehaviour switches
        self.drop_after_reply = False
        self.ready_after = None       # seconds before itemReady follows more_info
        self.ready_findings = [{"text": "Postgres is used elsewhere.", "source": "docs/adr/0002.md"}]
        self.raw_response = None      # bytes sent instead of any answer
        self.error_data = None
        self.silent = False
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
        shown = set()
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
                    result, after = self._dispatch(n, msg["method"], msg.get("params") or {}, shown)
                    reply = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
                except RpcError as e:
                    err = {"code": e.code, "message": e.message}
                    if self.error_data is not None:
                        err["data"] = self.error_data
                    reply, after = {"jsonrpc": "2.0", "id": msg["id"], "error": err}, None
                if after == "drop":
                    break
                f.write(json.dumps(reply).encode() + b"\n")
                f.flush()
                if after:
                    after(f)
        except (OSError, ValueError):
            pass
        finally:
            with self.lock:
                for feat, (holder, _) in list(self.locks.items()):
                    if holder == n:
                        del self.locks[feat]
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

    def _next(self, feature, shown):
        items = self.features[feature]["items"]
        for it in items:
            if it["status"] == "deferred" and it["id"] not in shown:
                shown.add(it["id"])
                return copy.deepcopy(it)
        for it in items:
            if it["status"] in ("open", "researching") and it["id"] not in shown:
                shown.add(it["id"])
                return copy.deepcopy(it)
        return None

    def _dispatch(self, n, method, params, shown):
        if method == "engine.status":
            return {"version": "1.1.0", "uptime_s": 5, "features": []}, None
        if method == "feature.start":
            self.started.append(params["request"])
            return {"feature": "F-100"}, None
        if method == "interview.list":
            return {"features": [
                {"id": fid, "title": f["title"],
                 "open": sum(i["status"] == "open" for i in f["items"] if i["kind"] == "question"),
                 "deferred": sum(i["status"] == "deferred" for i in f["items"]),
                 "pending_assumptions": sum(i["status"] == "open" for i in f["items"] if i["kind"] == "assumption")}
                for fid, f in self.features.items()]}, None
        feature = params.get("feature")
        if feature not in self.features:
            raise RpcError(UNKNOWN, "unknown feature")
        if method == "interview.state":
            it = self._find(feature, params["item"])
            out = {"status": it["status"], "revision": it["revision"]}
            if "recorded_at" in it:
                out["recorded_at"] = it["recorded_at"]
            return out, None
        with self.lock:
            holder = self.locks.get(feature)
            if holder and holder[0] != n:
                raise RpcError(BUSY, f"busy: another session started at {holder[1]}")
            if method == "interview.next":
                self.locks[feature] = (n, "2026-11-10T09:00:00Z")
                return {"item": self._next(feature, shown)}, None
            if not holder:
                raise RpcError(BUSY, "no session: call interview.next first")
        if method == "interview.close":
            del self.locks[feature]
            return {"ok": True}, None
        if method == "interview.reply":
            return self._reply(feature, params, shown)
        raise RpcError(-32601, "method not found")

    def _reply(self, feature, p, shown):
        if p["reply_id"] in self.replies:
            return self.replies[p["reply_id"]], None
        it = self._find(feature, p["item"])
        if p["revision"] != it["revision"]:
            raise RpcError(STALE, "stale: the item has changed")
        assumption = p["kind"] in ("approve_assumption", "reject_assumption")
        if assumption != (it["kind"] == "assumption"):
            raise RpcError(-32602, "reply kind does not fit the item")
        it.setdefault("replies", []).append(p)
        it["recorded_at"] = "2026-11-10T10:00:00Z"
        it["status"] = {"answer": "answered", "defer": "deferred", "more_info": "researching",
                        "approve_assumption": "approved", "reject_assumption": "rejected"}[p["kind"]]
        after = None
        if p["kind"] == "more_info":
            result = {"status": "researching"}
            if self.ready_after is not None:
                after = self._ready_later(feature, it)
        else:
            result = {"status": it["status"], "next": self._next(feature, shown)}
        self.replies[p["reply_id"]] = result
        if self.drop_after_reply:
            return result, "drop"
        return result, after

    def _ready_later(self, feature, it):
        def send(f):
            time.sleep(self.ready_after)
            it["revision"] += 1
            it["status"] = "open"
            it["findings"] = self.ready_findings
            note = {"jsonrpc": "2.0", "method": "feature.stageChanged", "params": {"feature": feature}}
            f.write(json.dumps(note).encode() + b"\n")
            note = {"jsonrpc": "2.0", "method": "interview.itemReady",
                    "params": {"feature": feature, "item": copy.deepcopy({k: v for k, v in it.items()
                                                                          if k not in ("replies", "recorded_at")})}}
            f.write(json.dumps(note).encode() + b"\n")
            f.flush()
        return send


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message
