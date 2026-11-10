"""Stand-in engine on a Windows named pipe, for the first Windows run of the
interview client (F-005 SR-7). There is no engine yet, so this serves the
developer fake engine's channel v1.1 logic over a real pipe.

The pipe is byte-mode and synchronous, created with FILE_FLAG_FIRST_PIPE_INSTANCE
and PIPE_REJECT_REMOTE_CLIENTS, which is what Node's net server (the real
engine, ADR 0001) gives a client too. Several instances wait at once, as
libuv's do, so back-to-back clients never find the pipe missing.

Usage: python pipe_engine.py <pipe name> <mode>
Modes: normal, silent (reads, never answers), drop (closes after the first
request), big (a question just under 1 MiB). Prints READY once listening.
"""
import ctypes
import json
import os
import sys
import threading
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fake_engine  # noqa: E402

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateNamedPipeW.restype = wintypes.HANDLE
k32.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
k32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                          ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
k32.DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

INVALID = wintypes.HANDLE(-1).value
PIPE_ACCESS_DUPLEX, FIRST_INSTANCE = 0x3, 0x00080000
PIPE_REJECT_REMOTE_CLIENTS = 0x8
ERROR_PIPE_CONNECTED = 535

QUESTION = "Which database — Postgres or SQLite? ✓ 数据库 \U0001f600"


def make_engine(mode):
    # FakeEngine's constructor binds a Unix socket, which Windows Python lacks,
    # so only its state is set up here.
    e = fake_engine.FakeEngine.__new__(fake_engine.FakeEngine)
    e.features, e.calls, e.connections = {}, [], 0
    e.sessions, e.locks, e.replies, e.started = {}, {}, {}, []
    e.lock = threading.Lock()
    e.drop_after_reply, e.ready_after, e.raw_response, e.error_data = False, None, None, None
    e.ready_findings, e.notify_first = [], False
    e.silent = mode == "silent"
    text = "Q" * (1024 * 1024 - 400) if mode == "big" else QUESTION
    e.features["F-001"] = {"title": "Café export — déjà vu",
                           "items": [fake_engine.item("Q1", text),
                                     fake_engine.item("A1", "Assume UTF-8 everywhere → ok?", kind="assumption")]}
    return e


def create(name, first):
    flags = PIPE_ACCESS_DUPLEX | (FIRST_INSTANCE if first else 0)
    h = k32.CreateNamedPipeW(name, flags, PIPE_REJECT_REMOTE_CLIENTS, 255, 65536, 65536, 0, None)
    if h in (None, INVALID):
        raise OSError(ctypes.get_last_error(), "CreateNamedPipeW failed")
    return h


def write_all(h, data):
    done = wintypes.DWORD()
    while data:
        if not k32.WriteFile(h, data, len(data), ctypes.byref(done), None):
            return False
        data = data[done.value:]
    return True


def serve(engine, mode, h):
    buf, chunk, got = b"", ctypes.create_string_buffer(65536), wintypes.DWORD()
    try:
        while True:
            if not k32.ReadFile(h, chunk, 65536, ctypes.byref(got), None) or not got.value:
                return
            buf += chunk.raw[:got.value]
            while b"\n" in buf:
                line, _, buf = buf.partition(b"\n")
                if mode == "drop":
                    return
                msg = json.loads(line)
                if engine.silent:
                    continue
                try:
                    result, drop = engine._dispatch(msg["method"], msg.get("params") or {})
                    reply = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
                except fake_engine.RpcError as e:
                    reply, drop = {"jsonrpc": "2.0", "id": msg["id"],
                                   "error": {"code": e.code, "message": e.message}}, False
                if drop or not write_all(h, json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n"):
                    return
    finally:
        k32.FlushFileBuffers(h)
        k32.DisconnectNamedPipe(h)
        k32.CloseHandle(h)


def listen(engine, mode, name, h):
    while True:
        if not k32.ConnectNamedPipe(h, None) and ctypes.get_last_error() != ERROR_PIPE_CONNECTED:
            k32.CloseHandle(h)
        else:
            threading.Thread(target=serve, args=(engine, mode, h), daemon=True).start()
        h = create(name, False)


def main():
    name, mode = sys.argv[1], sys.argv[2]
    engine = make_engine(mode)
    first = create(name, True)
    for h in [first] + [create(name, False) for _ in range(3)]:
        threading.Thread(target=listen, args=(engine, mode, name, h), daemon=True).start()
    print("READY", flush=True)
    sys.stdin.read()  # runs until the driver closes stdin or kills it


if __name__ == "__main__":
    main()
