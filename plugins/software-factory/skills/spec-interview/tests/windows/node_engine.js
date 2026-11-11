// Minimal stand-in engine on a Node named-pipe server. The real engine is
// Node (ADR 0001), and libuv makes its pipes differently from the Python
// stand-in (overlapped, its own default ACL), so the client is checked
// against both. Usage: node node_engine.js <pipe name>; prints READY.
"use strict";
const net = require("net");
const crypto = require("crypto");

const name = process.argv[2];
const items = { Q1: { id: "Q1", revision: 1, kind: "question", status: "open",
  text: "Node engine: which queue — Redis or SQS? ✓", why: "It decides retries." } };
let lock = null;

function handle(m) {
  const p = m.params || {};
  switch (m.method) {
    case "engine.status": return { version: "1.1.0", uptime_s: 1, features: [{ id: "F-002" }] };
    case "interview.list":
      return { features: [{ id: "F-002", title: "Queue choice", open: items.Q1.status === "open" ? 1 : 0,
        deferred: 0, pending_assumptions: 0 }] };
    case "interview.open":
      if (p.feature !== "F-002") throw { code: -32003, message: "unknown feature" };
      if (lock && !p.takeover) throw { code: -32001, message: "busy" };
      lock = crypto.randomBytes(16).toString("hex");
      return { session: lock, started_at: "2026-11-10T09:00:00Z" };
  }
  if (!lock || p.session !== lock) throw { code: -32004, message: "unknown or expired session" };
  switch (m.method) {
    case "interview.next": return { item: items.Q1.status === "open" ? items.Q1 : null };
    case "interview.reply":
      if (p.revision !== items.Q1.revision) throw { code: -32002, message: "stale" };
      items.Q1.status = "answered";
      return { status: "answered", next: null };
    case "interview.close": lock = null; return { ok: true };
  }
  throw { code: -32601, message: "method not found" };
}

net.createServer((c) => {
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      let out;
      try { out = { jsonrpc: "2.0", id: m.id, result: handle(m) }; }
      catch (e) { out = { jsonrpc: "2.0", id: m.id, error: { code: e.code, message: e.message } }; }
      c.write(JSON.stringify(out) + "\n");
    }
  });
  c.on("error", () => {});
}).listen(name, () => console.log("READY"));
