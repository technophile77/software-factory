// Values fixed by approved contracts and reviews. Changing any of them is a
// change to an approved interface or pin, not a tuning knob.

/**
 * The channel version this engine serves, as written to engine.json and
 * returned by engine.status. The v1.3 advisor kinds are refused with
 * kind_not_allowed until the advisor increment, so the engine reports 1.2:
 * the F-005/F-006 client offers the advisor only when it sees 1.3 or later
 * (F-007 FR-4, F-006 FR-11).
 */
export const SERVED_CHANNEL_VERSION = "1.2";

/**
 * What this engine accepts beyond its version, as written to engine.json and
 * returned by engine.status (channel v1.4, owner decision 2026-11-12). The
 * version can't say it: the engine takes `document` (v1.4) while still
 * reporting 1.2, because it doesn't serve v1.3's advisor yet.
 */
export const CAPABILITIES: readonly string[] = ["document"];

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const FEATURE_ID_RE = /^F-(\d{3,6})$/;
export const SESSION_RE = /^[0-9a-f]{32}$/;

/** Channel framing (v1.1): one message per line, at most 1 MiB. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  busy: -32001,
  stale: -32002,
  unknown: -32003,
  session: -32004,
  kindNotAllowed: -32005,
  approvalPending: -32006,
  approvalFailed: -32007,
  /** A security refusal (H-0084). The message is always REFUSED_MESSAGE; the reason goes in a Security item. */
  refused: -32008,
  /** Channel v1.4 (H-0105): a feature.start document the engine won't store; `data` names lines and rules only. */
  documentRefused: -32009,
} as const;

/** The one message -32008 carries, so a refusal never tells the client what was found or where. */
export const REFUSED_MESSAGE = "Refused for a security reason. The reason is in a Security inbox item.";

/** Channel v1.1 waits. */
export const MAX_NEXT_WAIT_S = 600;
export const MAX_APPROVAL_WAIT_S = 900;

/** ADR 0014 lifetimes. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 2 * 60 * 60 * 1000;

/** SR-23: GitHub's device flow, exactly. */
export const DEVICE_VERIFICATION_URI = "https://github.com/login/device";
export const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const MAX_DEVICE_EXPIRES_S = 900;
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const GITHUB_WEB_BASE = "https://github.com";
export const GITHUB_API_BASE = "https://api.github.com";

/** Interview tools v1.0 limits. */
export const TOOL_LIMITS = {
  text: 4000,
  why: 2000,
  options: 8,
  option: 200,
  findings: 20,
  findingText: 2000,
  findingSource: 2000,
  query: 400,
  openAssumptions: 5,
  itemsPerFeature: 200,
  /** Interview tools v1.1 (H-0106): one `## Sources` row's quote, and rows per table. */
  sourceQuote: 1000,
  sourceRows: 200,
} as const;

/** Channel v1.4 (H-0105, F-009 OQ-3): a document handed over at feature.start. */
export const DOCUMENT_LIMITS = {
  textBytes: 262_144,
  name: 200,
} as const;

/** The secrets scanner, pinned by Gate 1 component review 5. */
export const GITLEAKS_VERSION = "8.30.1";
export const GITLEAKS_BINARY_SHA256: Readonly<Record<string, string>> = {
  "linux-x64": "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
  "linux-arm64": "00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b",
  "darwin-x64": "cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291",
  "darwin-arm64": "ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f",
  "win32-x64": "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c",
  "win32-arm64": "200df852fdecbedb19a33960657333cba5e231740bc8968972b507b50f93b194",
};
/** Only [extend] useDefault: the rules are the ones built into the pinned binary. */
export const GITLEAKS_RULES = "[extend]\nuseDefault = true\n";
export const GITLEAKS_TIMEOUT_S = 120;

/** SR-18: at most 3 resumes per run, then `failed`. */
export const MAX_RESUMES = 3;

export const STATE_BRANCH = "factory/state";
export const PATHS_FILE = "factory-projects.local.yaml";
export const MANIFEST_FILE = "factory-project.yaml";
export const ENGINE_JSON = "engine.json";
export const CREDENTIAL_SERVICE = "software-factory-engine";
export const INTERVIEW_STAGE = "requirements_interview";
export const AFTER_INTERVIEW_STAGE = "security_gate_1";
