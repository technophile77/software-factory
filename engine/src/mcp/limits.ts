/** What the MCP mode accepts from the engine and from Claude (F-005, channel v1.1 to v1.4). */

/**
 * The tool set's version (F-005 FR-18). The skill names the version it was
 * written for; bump this whenever a tool's name, inputs or results change.
 */
export const TOOLS_VERSION = 1;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SESSION_RE = /^[0-9a-f]{32}$/;
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const ENGINE_VERSION_RE = /^1\.([1-9]\d*)$/;
export const CAPABILITY_RE = /^[a-z][a-z0-9_]{0,31}$/;
// Only local pipes: `\\host\pipe\x` reaches another machine and `\\?\` skips the namespace checks (SR-7).
export const PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._{}-]{1,200}$/;
export const STATE_BRANCH = "refs/heads/factory/state";
export const MAX_MESSAGE = 1024 * 1024; // SR-15
export const MAX_ENGINE_JSON = 64 * 1024;
export const CALL_TIMEOUT_S = 60; // SR-15, per channel call
/** Every tool returns within this, whatever wait it asked the engine for (SR-15). */
export const RUN_LIMIT_S = 150;
/** Left over after the engine's wait, for its answer to arrive in time. */
export const WAIT_MARGIN_S = 15;
export const MAX_WAIT_S = 600;
export const MAX_APPROVAL_WAIT_S = 900;

/** Channel error codes; the skill acts on the name, the owner sees the client's sentence. */
export const ERROR_NAMES: Record<number, string> = {
  [-32001]: "busy", [-32002]: "stale", [-32003]: "unknown", [-32004]: "session_expired",
  [-32005]: "kind_not_allowed", [-32006]: "approval_pending", [-32007]: "approval_failed",
  [-32008]: "refused", [-32009]: "document_refused",
};
export const ERROR_TEXT: Record<string, string> = {
  busy: "Another session holds this feature.",
  stale: "The analyst changed this item since it was shown.",
  unknown: "The engine doesn't know that feature or item.",
  session_expired: "This interview session has ended or expired.",
  kind_not_allowed: "That kind of reply doesn't fit this item.",
  approval_pending: "The session is waiting for your GitHub approval.",
  approval_failed: "GitHub approval failed or expired, so the session was closed.",
  refused: "The engine refused this for a security reason; see the Security inbox.",
  document_refused: "The engine refused the document; nothing was stored.",
};

export const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const DEVICE_URI = "https://github.com/login/device";
export const VERSION_RE = /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/;
export const REPLY_KINDS = ["answer", "more_info", "defer", "approve_assumption", "reject_assumption",
  "ask_advisor", "approve_advisor", "decline_advisor", "confirm_sources", "reopen_sources"] as const;
export const ITEM_KINDS = ["question", "assumption", "advisor_proposal", "source_confirmation"] as const;
export const QUESTION_TYPES = ["gap", "conflict", "ambiguity"] as const;
export const ITEM_STATUSES = ["open", "deferred", "researching", "answered", "approved", "rejected", "superseded"] as const;
export const ADVICE_STATUSES = ["running", "done", "failed"] as const;
export const ADVISOR_KINDS = ["ask_advisor", "approve_advisor", "decline_advisor"];
export const LIMITS = ["turns", "tokens", "time_s", "web_calls"] as const;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const STAGE_RE = /^[a-z0-9_]{1,40}$/;
export const MAX_REASON = 500;
export const INTERVIEW_STAGE = "requirements_interview";

// Channel v1.4 (F-009 OQ-2, OQ-3): what a handed-over document may be.
export const DOC_TYPES: Record<string, string> = { ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain" };
export const DOC_MAX_BYTES = 262_144;
export const DOC_PROVENANCE = ["owner", "reference"] as const;
export const DOC_REASONS: Record<string, string> = {
  invalid: "it isn't text the engine accepts (bad encoding, control characters, or a field out of range)",
  hidden_content: "it has text a reader can't see: an HTML comment, raw HTML, a zero-width or bidi character, "
    + "a link definition with a title or that no link uses, or a link or image with empty text. Remove it and try again",
  secret: "the secrets scan found a secret in it. Remove the secret and try again",
  budget: "the project's remaining budget can't cover it",
};
export const RULE_RE = /^[A-Za-z0-9_.-]{1,100}$/;
