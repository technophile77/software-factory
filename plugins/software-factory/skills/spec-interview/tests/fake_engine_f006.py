"""A fake engine for Engine control channel v1.3 (H-0063, F-006), built by the
test engineer from the contract alone.

It extends the F-005 contract fake (`test_acceptance.FakeEngine`, channel
v1.1) with what v1.3 adds:
- item kind `advisor_proposal` (the analyst proposes an advisor call on
  question `about`, with its reason in `why`);
- `advice: [{call, status, text?, web_queries?}]` on questions;
- reply kinds `ask_advisor` (questions), `approve_advisor` and
  `decline_advisor` (advisor proposals). Each starts at most one advisor
  call; a proposal becomes `approved` or `rejected`.

What the contract leaves open is chosen here as plainly as possible, and the
tests don't depend on it: `ask_advisor` leaves the question's status and
revision as they were (the question "stays open while the advisor works",
spec 2.3), and the reply's `status` is the item's status afterwards.

Round 2 adds amendment H-0075 (awaiting the owner): advice entries carry
`revision` and, when done, `sha256`; a failed call carries `reason`; a
decided proposal answers `stale` (already so here: only open, deferred or
researching items take replies). `advice_queries = None` leaves
`web_queries` out (the engine didn't report them).
"""
import copy
import hashlib
import time

from test_acceptance import ID_RE, FakeEngine, RpcError, now_iso

QUESTION_KINDS = ("answer", "more_info", "defer", "ask_advisor")
ASSUMPTION_KINDS = ("approve_assumption", "reject_assumption")
PROPOSAL_KINDS = ("approve_advisor", "decline_advisor")

# Advisor output in the FR-8 shape, as the engine stored it.
VALID_ADVICE = (
    "## Findings\n"
    "- SQLite handles one writer at a time. Source: repo:docs/adr/0002.md\n"
    "- Postgres needs a server. Source: web:https://www.postgresql.org/docs/ (untrusted)\n"
    "## Options\n"
    "1. SQLite: no server; one writer.\n"
    "2. Postgres: many writers; a server to run.\n"
    "## Recommendation\n"
    "Option 1, because the factory has one writer. Confidence: medium\n"
    "## Risks and unknowns\n"
    "- Writer count may grow."
)


def sha256_hex(text):
    """H-0075: lowercase hex SHA-256 of the UTF-8 bytes of the stored advice."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def proposal(iid, about, why="The question cross-cuts budgets and sandboxing.", status="open", **kw):
    item = {"id": iid, "revision": 0, "kind": "advisor_proposal",
            "text": f"Ask the advisor about {about}?", "why": why, "about": about, "status": status}
    item.update(kw)
    return item


class AdvisorEngine(FakeEngine):
    def __init__(self, state=None):
        super().__init__(state)
        self.advisor_calls = []      # {"call", "question", "via", "reply_id", "at"}
        self.advisor_s = 0.2         # how long a call runs before its advice is ready
        self.advice_text = VALID_ADVICE
        self.advice_queries = ["sqlite concurrent writers"]
        self.advice_fails = False

    # -- advisor calls -------------------------------------------------------
    def _start_call(self, feature, qid, via, rid):
        q = self.item(feature, qid)
        call = f"A-{len(self.advisor_calls) + 1:04d}"
        self.advisor_calls.append({"call": call, "question": qid, "via": via, "reply_id": rid, "at": now_iso()})
        # H-0075: `revision` is the question's revision the call was asked about.
        q.setdefault("advice", []).append({"call": call, "status": "running", "revision": q["revision"],
                                           "_ready_at": time.monotonic() + self.advisor_s})
        return call

    def _settle(self, feature):
        super()._settle(feature)
        for it in self.features[feature]["items"]:
            advice = it.get("advice")
            # Malformed advice (tests of the client's checks) is sent as is.
            for a in advice if isinstance(advice, list) else []:
                # Only calls this engine started finish; a "running" entry a
                # test planted stays running.
                if (isinstance(a, dict) and a.get("status") == "running" and "_ready_at" in a
                        and time.monotonic() >= a["_ready_at"]):
                    a.pop("_ready_at", None)
                    if self.advice_fails:
                        a["status"] = "failed"
                        a["reason"] = "output did not have the four sections"
                    else:
                        a["status"] = "done"
                        a["text"] = self.advice_text
                        a["sha256"] = sha256_hex(self.advice_text)
                        if self.advice_queries is not None:
                            a["web_queries"] = list(self.advice_queries)

    @staticmethod
    def _wire(item):
        if item is None:
            return None
        out = {k: v for k, v in item.items() if not k.startswith("_")}
        if isinstance(out.get("advice"), list):
            out["advice"] = [{k: v for k, v in a.items() if not k.startswith("_")} if isinstance(a, dict) else a
                             for a in out["advice"]]
        return copy.deepcopy(out)

    # -- v1.3 reply ------------------------------------------------------------
    def m_interview_reply(self, p):
        with self.lock:
            _, s = self._session(p)
            rid = p.get("reply_id")
            if not isinstance(rid, str) or not ID_RE.match(rid):
                raise RpcError(-32602, "Invalid params: reply_id")
            if rid in self.replies:
                return copy.deepcopy(self.replies[rid])
            try:
                it = self.item(s["feature"], p.get("item"))
            except KeyError:
                raise RpcError(-32003, "Unknown item") from None
            if p.get("revision") != it["revision"] or it["status"] not in ("open", "deferred", "researching"):
                raise RpcError(-32002, "Stale revision")
            kind = p.get("kind")
            allowed = {"question": QUESTION_KINDS, "assumption": ASSUMPTION_KINDS,
                       "advisor_proposal": PROPOSAL_KINDS}.get(it["kind"], ())
            if kind not in allowed:
                raise RpcError(-32005, "Reply kind not allowed for this item")
            if not isinstance(p.get("text"), str):
                raise RpcError(-32602, "Invalid params: text")
            feature = s["feature"]
            if kind == "ask_advisor":
                self._start_call(feature, it["id"], kind, rid)
                new = it["status"]
            elif kind == "approve_advisor":
                it["status"] = new = "approved"
                self._start_call(feature, it["about"], kind, rid)
            elif kind == "decline_advisor":
                it["status"] = new = "rejected"
            else:
                new = {"answer": "answered", "defer": "deferred", "more_info": "researching",
                       "approve_assumption": "approved", "reject_assumption": "rejected"}[kind]
                it["status"] = new
                if new == "researching":
                    it["_ready_at"] = time.monotonic() + self.research_s
                if new == "deferred":
                    s["shown"].add(it["id"])
            self.transcript.append({"feature": feature, "item": it["id"], "kind": kind,
                                    "text": p["text"], "reply_id": rid, "at": now_iso()})
            result = {"status": new, "next": self._wire(self._pick(s))}
            self.replies[rid] = copy.deepcopy(result)
            return result
