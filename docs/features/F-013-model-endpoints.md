# Feature: Configurable model endpoints

- **Id:** F-013
- **Status:** Approved (owner, 2026-11-13; readiness gate passed); LiteLLM accepted with conditions (OQ-9); A-1 spike failed as-is ([report](F-013-spike-a1.md)), back with the owner (OQ-10)
- **Requested by / date:** Alex, 2026-11-13 ("I want to also incorporate a
  local llm api"; "this model would be a good candidate for the security
  agent, judge, or any low end agent"; "I'd rather allow a number of
  endpoints that can be specified, and allow them to be configurable, with
  local as an option that indicates it has unlimited usage"; "endpoints
  should include standard options like the model to use and an api key")
- **Spec version:** 18

## 1. Objective and business purpose
The factory runs every agent on Claude today. The owner wants to add other
model APIs as well: their own LLM server on the LAN first, and any other
API endpoint they choose later. Each endpoint is configured with the usual
options (base URL, model, API key, limits) and a billing mode (owner,
2026-11-13): `local` (unlimited usage: nothing per token and no budget,
though still limited by speed and sessions), `per_token` (priced per token,
counted against the project budget), or `subscription` (a flat plan with
usage limits, counted as a share of those limits).

The factory doesn't build its own multi-provider layer: it runs LiteLLM, an
open-source LLM proxy that already translates between API formats, holds
per-endpoint keys, and enforces budgets and rate limits (owner, 2026-11-13:
"that's exactly the thing that should be included instead of building
another thing"; OQ-8). The factory adds what LiteLLM doesn't know about:
which role and project may use which endpoint, keeping keys and addresses
out of agent containers, and the F-002 evidence that picks rungs.

The factory already decides each role's model by evidence (F-002): the
cheapest rung that passes calibration, approved by the owner. Each
configured endpoint becomes a rung like any other, so the same evidence and
approvals decide where it is used. Nothing switches a role on its own.

Endpoint addresses and keys are owner-specific and never go into the public
master repo.

## 2. Expected behavior
1. **Setup, once per PC.** The owner lists endpoints in a machine-local
   file next to `factory-projects.local.yaml` (git-ignored, writable only
   by the owner, like H-0081's paths file). Each endpoint has a name, base
   URL, model, API format, optional API key (as the name of an entry in
   the OS credential store), session cap, and billing mode with its
   prices or plan limits. The engine checks each at start (FR-6) and shows any
   problem as a plain message in the engine status.
2. **Each endpoint is a rung.** A configured endpoint is a candidate rung,
   named `<endpoint>/<model>` (for example `lan/qwen3.8-27b`). The master
   repo names no endpoint. A PC without that endpoint simply doesn't have
   the rung.
3. **Projects choose which endpoints may see their code.** A project uses
   only the endpoints its manifest allows (SR-8); none by default.
4. **Agents don't change.** An agent on an endpoint rung still runs Claude
   Code in its container. Its model requests go to the engine's credential
   gateway as today. For an endpoint session, the gateway forwards them to
   the factory's LiteLLM container, naming the endpoint the engine granted
   for that session; LiteLLM translates the format if the endpoint speaks
   OpenAI's, adds that endpoint's key, and calls it through the factory's
   egress proxy (OQ-2, OQ-8, ADR 0019). The agent never learns the address
   or the key.
5. **Choosing roles.** As F-002: calibration, then the role's transcripts,
   then a hygiene item the owner approves. Before F-002's calibration is
   built, the owner can set a role to an endpoint rung in
   `engine/config/models.yaml` through a hygiene item. Gate roles get an
   endpoint only as an advisory first pass (OQ-1). Calibration starts with
   the gate roles and the low-end roles (OQ-4).
6. **Busy or down.** The engine sends no more than an endpoint's session
   cap to it. A session that waits more than 10 minutes for a slot, or whose
   request passes its size-scaled deadline, runs on the role's Claude rung
   instead, noted in the run review (OQ-5, FR-12).
7. **Usage and reports.** Each agent report records the rung with its
   endpoint. By billing mode: `local` costs $0 and counts against no
   budget; `per_token` costs its tokens times its prices and counts against
   the project budget like Claude spend (ADR 0012); `subscription` counts
   as the share of its plan limits used, and the engine stops sending to it
   before the limits run out. Tokens and time are recorded for all three.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | A rung (and, before F-002, a `models.yaml` entry) can name `<endpoint>/<model>`. The master repo holds no endpoint address, host, port or key. |
| FR-2 | `factory-endpoints.local.yaml` in the master clone, git-ignored, lists named endpoints. Each has: `base_url`, `model`, `api` (`anthropic` or `openai`; OQ-6), optional `api_key_ref` (a credential store entry name), `max_sessions` (default 1), `billing` (`local`, `per_token` or `subscription`; required), `prices` (input and output per million tokens; required for `per_token`), `plan` (for `subscription`: one or more limits, each a count of requests, input tokens or output tokens per window of 5 hours, a day, a week or a month, plus an optional `reserve_pct`, default 10), optional `deadline` overrides (FR-12), and `allow_loopback` (default false). The file is refused unless only the owner can write it (as H-0081). |
| FR-3 | API keys come only from the OS credential store. The engine hands each to the LiteLLM container alone, at its start, the way it hands the Claude credential to the proxy today (never in an argument, a committed file or an agent's environment). The Claude credential is never given to LiteLLM, and LiteLLM sends each key only to its own endpoint (SR-13). |
| FR-4 | Before each session, the engine resolves the endpoint's host on the PC (so `.local` mDNS names work) and pins the address it checked. A **private** endpoint (every address in RFC 1918, RFC 4193 or link-local; loopback only with `allow_loopback`) may use plain HTTP and no key (SR-5). A **public** endpoint (every address public) must use HTTPS with certificate checks and an API key (SR-12). A name resolving to a mix of private and public addresses is refused. |
| FR-5 | The gateway forwards an endpoint session's `/v1/messages` and `/v1/messages/count_tokens` requests, with the body checks it applies today, to the LiteLLM container, naming the session's granted endpoint; the grant names the endpoint and an agent cannot choose it. LiteLLM's own egress goes through the factory's egress proxy under a grant that allows only the configured endpoints, each at its address pinned per FR-4 (plain HTTP forwarding is allowed only to a private endpoint). |
| FR-6 | At start, the engine checks each endpoint: it lists the configured model (`GET /v1/models`) and answers an Anthropic Messages request with a tool call. A failing endpoint's rungs are unavailable, with the reason. |
| FR-7 | No more than an endpoint's `max_sessions` run on it at once. A session that waits more than 10 minutes for a slot, whose endpoint is unreachable, or whose request passes its FR-12 deadline, runs on the role's Claude rung instead; the run review records each fallback with role, endpoint, reason, prompt size and time waited. |
| FR-8 | The agent report's `model` field carries the endpoint prefix (`<endpoint>/<model>`); metrics, run reviews and the calibration result group by it. |
| FR-9 | A role on an endpoint rung that fails its run is attributed and stepped up exactly as F-002 says; nothing here bypasses F-002's approvals. |
| FR-10 | Gate roles (security reviewer, validation judge) stay on their Claude rung (F-002 A-3 unchanged). An endpoint enabled for a gate role runs first as an advisory pass on the same inputs; its findings or verdict go to the Claude reviewer as data, which still decides. The run review records, per run, how many of the Claude reviewer's findings the advisory pass also found and at what severity, plus its verdict match (OQ-1). |
| FR-11 | The advisory pass never blocks or delays a gate beyond the 10-minute slot wait: if it is unavailable, the Claude reviewer runs without it. |
| FR-12 | Request deadlines scale with size (owner, 2026-11-13). Each request's deadline is a fixed margin plus its prompt tokens divided by the endpoint's measured prompt-processing rate plus its `max_tokens` divided by its measured generation rate. Rates come from the server's per-request timings where it reports them (`llama-server` does), otherwise from measured wall time, kept per endpoint and model as a rolling median and seeded by a timing check at start. The run review reports rates by prompt-size band (under 8k, 8k to 32k, 32k to 128k, over 128k tokens). |
| FR-14 | Format translation, keys and retries come from LiteLLM (OQ-8). Billing (FR-13) stays a factory requirement: LiteLLM enforces the limits it can express (spend caps per endpoint, request and token rate limits), and the engine does the rest itself: charging `per_token` cost to the project budget, counting `subscription` plan windows LiteLLM can't express (such as 5 hours), the reserve and fallback, and recording cost in agent reports, F-002 metrics and run reviews. The engine generates LiteLLM's configuration from the endpoints file at start; LiteLLM's admin UI, database and telemetry are off, and its master key is random per run and known only to the gateway. The factory writes no format translator of its own. |
| FR-15 | LiteLLM is pinned to one image digest in the master repo and upgraded only by a hygiene item. Before each upgrade, and in CI, a conformance suite replays fixed tool-call conversations (generic prompts only) through LiteLLM to a recorded stub endpoint in each format and checks that Claude Code receives the same `tool_use` names, arguments and stop reasons as from a native Anthropic endpoint, streamed and unstreamed. |
| FR-13 | Usage by billing mode. `local`: cost $0 (0% of plan in the project's `subscription` budget mode), not counted against the project budget (ADR 0012). `per_token`: tokens times `prices`, in dollars, counted against the project budget in both budget modes. `subscription`: the engine counts each limit's use per window across all projects on the PC; a task's cost is the largest share of any limit it used (as F-002 A-1 measures Claude plans); it is not charged in dollars. When any limit would pass `100 - reserve_pct` percent in its window, new sessions for that endpoint run on the role's Claude rung instead (FR-7), so the owner keeps the reserve for their own use. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a change to the master repo, when CI runs, then it fails if `factory-endpoints.local.yaml` is tracked, or if any tracked file outside a short allow list of documentation examples holds a `.local` host name, a private IPv4 or IPv6 address (RFC 1918, RFC 4193), or a URL with a port on such a host. | FR-1 |
| AC-2 | Given `factory-endpoints.local.yaml` writable by another user, when the engine starts, then no endpoint rung is available and the status says why. | FR-2 |
| AC-3 | Given a public endpoint with an `http://` URL or no `api_key_ref`, when the engine starts, then its rungs are unavailable with that reason. | FR-4, SR-12 |
| AC-4 | Given an endpoint session, when the agent sends a model request, then it reaches that endpoint's pinned address only, carrying that endpoint's key if it has one and never the Claude credential. | FR-3, FR-5 |
| AC-5 | Given an endpoint session, when the agent tries to reach the endpoint directly (not through the gateway), then the proxy refuses it (F-007 SR-8 unchanged). | FR-5 |
| AC-6 | Given an endpoint that doesn't list its configured model, when the engine starts, then its rungs are unavailable with that reason. | FR-6 |
| AC-7 | Given `max_sessions: 1` and two sessions for that endpoint starting, then the second waits until the first ends. | FR-7 |
| AC-8 | Given a run on a `local` endpoint, when its report is written, then `model` starts with the endpoint name and its cost is 0, and the project budget is unchanged. | FR-8, FR-13 |
| AC-9 | Given the endpoint times out, then the session runs on the role's Claude rung and the run review records the fallback with role, endpoint and reason. | FR-7 |
| AC-10 | Given a gate role with an advisory endpoint enabled, when the gate runs, then the Claude reviewer receives the advisory findings as data and its own report decides the gate; the run review records the match rate. Given that endpoint is down, the gate still completes on Claude alone. | FR-10, FR-11 |
| AC-11 | Given measured rates of 200 prompt and 10 generation tokens per second and a 60-second margin, when a request has a 100,000-token prompt and `max_tokens` 4,000, then its deadline is 60 + 500 + 400 = 960 seconds; a request still running after that falls back per FR-7. | FR-12 |
| AC-12 | Given a `per_token` endpoint priced at $1 / $2 per million tokens, when a run uses 1M input and 0.5M output tokens on it, then its cost is $2 and the project budget is charged $2. | FR-13 |
| AC-15 | Given an `openai` endpoint, when an agent's request carries two tools and the model calls one, then the agent receives an Anthropic `tool_use` block with the same name and arguments, streamed and unstreamed, and its `tool_result` reaches the endpoint as a `tool` message with the matching call id. | FR-14 |
| AC-16 | Given a LiteLLM image digest different from the pinned one, when the engine starts, then endpoint rungs are unavailable and the status says why. | FR-15 |
| AC-17 | Given the FR-15 conformance suite, when CI runs, then it passes for both formats; and the LiteLLM container has no network route except through the egress proxy. | FR-5, FR-15 |
| AC-14 | Given a `subscription` endpoint with a limit of 100 requests per 5 hours and `reserve_pct` 10, when 90 requests have been made in the current window, then the next session for that endpoint runs on the role's Claude rung and the run review says the plan limit was reached; a run that used 9 of those requests is recorded at 9% of plan. | FR-13 |
| AC-13 | Given a project whose manifest doesn't list an endpoint, when a role's rung names that endpoint, then the role runs on its Claude rung and the run review says why. | SR-8 |

## 5. Constraints
- First endpoint, measured 2026-11-13 from the owner's PC: one model,
  `Qwen3.8-27B-Uncensored` (GGUF, Q4_K_M, 27.3B parameters, 262,144-token
  context, text and image input), on llama.cpp's `llama-server` with 4
  parallel slots, no API key, plain HTTP, on the LAN. Its Anthropic Messages
  endpoint returned a correct `tool_use` block for a test tool (early
  evidence for A-1). Under the owner's other load it ran about 115 prompt
  tokens/s and 11 generated tokens/s. At that rate Claude Code's first turn,
  with its system prompt and tools (tens of thousands of tokens), takes
  minutes; later turns reuse the server's prompt cache. A 30-token request
  waited over 10 minutes for a slot while other long prompts ran.
- Claude Code needs the Anthropic Messages API, tool use and a large
  context. Endpoints that serve only OpenAI's chat-completions format are
  reached through LiteLLM's translation (OQ-6, OQ-8, FR-14).
- Change-controlled files touched: `engine/config/models.yaml`,
  `docs/interface-contracts.md`, the proxy, the engine's container plan
  (a LiteLLM container beside the proxy sidecar), `.gitignore`, CI.

## 6. Edge cases
- A private endpoint's `.local` name resolves to a different address later
  (DHCP, or another device answering mDNS): the check runs again before each
  session; a public answer refuses it.
- A public endpoint's name resolves to a private address (a DNS trick to
  reach the LAN): refused (FR-4).
- An endpoint's model is swapped: FR-6 and SR-11 catch it; its calibration
  results no longer apply.
- A long session outlives a server restart: the request fails and the run
  falls back per FR-7.
- The model returns malformed tool calls: Claude Code reports an error; the
  run fails and F-002 attributes it to the rung.
- Prompt injection: the first endpoint's model is an "uncensored"
  fine-tune with refusal training removed (SR-6).
- A non-local endpoint's provider changes its prices: the file is updated by
  the owner; costs before the change keep the old prices.

## 7. Dependencies
- F-002 (ladder, calibration, run reviews). Until it is built, the
  `models.yaml` path in § 2 item 5 is the only way a role uses an endpoint.
- Engine credential gateway and egress proxy (F-007, SR-6 to SR-9).
- ADR 0012 budgets (FR-13).
- The endpoints themselves (outside the factory).

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | LiteLLM's Anthropic-format endpoint (`/v1/messages`) works with Claude Code, including streaming and tool use, for both an Anthropic-format and an OpenAI-format endpoint behind it. Checked in a spike before build with the owner's `llama-server` (which speaks both); a failed spike sends the spec back. | OQ-2, OQ-8 | Approved (owner, 2026-11-13, decision card) in its v13 form |
| A-2 | An endpoint model's results count as F-002 calibration evidence the same way a Claude model's do: same tasks, same pass bar (F-002 A-2). | OQ-1 | Approved (owner, 2026-11-13, decision card) |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | External services (S9.1): the endpoints in the owner's file, each read-and-generate only (`GET /v1/models`, `POST /v1/messages`, `POST /v1/messages/count_tokens`). No other path. | Analyst (S9.1, S2.2) | Accepted (owner, 2026-11-13); widened in v9 from one server to the listed endpoints; re-approved (owner, 2026-11-13, decision card) |
| SR-2 | Endpoint addresses and keys never appear in Git, logs, agent environment or reports (S3.1, S3.3); logs name the endpoint, not the host. | Analyst (S3.1) | Accepted (owner, 2026-11-13, decision card) |
| SR-3 | Each endpoint's address is resolved on the PC, classed private or public, and pinned per session (FR-4). A private endpoint never resolves to a public address and a public one never to a private address, so a misconfigured or hijacked name can't send project content somewhere unexpected (S9.4; CWE-918). | Analyst | Accepted (owner, 2026-11-13); rescoped in v9 to both classes; re-approved (owner, 2026-11-13, decision card) |
| SR-4 | Agents still cannot reach private addresses or endpoints directly (F-007 SR-8 unchanged); only the gateway reaches an endpoint, and only for a session the engine granted it (S8.1). | Analyst (S8.1) | Accepted (owner, 2026-11-13, decision card) |
| SR-5 | Private endpoints only: no API key and plain HTTP are allowed; the private-address check and per-session pin (SR-3) are the controls. Accepted risk, stated to the owner: such a server takes requests from anyone on the LAN, prompts holding repo content cross the LAN unencrypted (CWE-319), and a `.local` name can be answered by any device on the LAN (mDNS is unauthenticated). | Analyst (S8.2; OWASP ASVS 5.0 V12; NIST SP 800-53 SC-8) | Risk accepted (owner, 2026-11-13, decision card); scope narrowed to private endpoints, approved (owner, 2026-11-13, decision card) |
| SR-6 | Endpoint responses are untrusted input like any model output (S4.5, S6.1). The web reader, which reads external content, doesn't use an endpoint unless calibration includes injection tasks and the owner approves (OWASP Top 10 for LLM Applications 2025, LLM01). | Analyst | Accepted (owner, 2026-11-13, decision card) |
| SR-7 | The model an endpoint serves is recorded with each calibration result (name and size from `/v1/models`), so results tie to the weights tested (S4.1; OWASP LLM03). | Analyst (S4.1) | Accepted (owner, 2026-11-13, decision card) |
| SR-8 | A project uses only the endpoints its manifest lists (`settings.endpoints: [<name>, ...]`, default empty); onboarding asks, and the run review shows which endpoints ran. The list is the only per-project control: evaluating an endpoint's terms, data handling and security is the user's responsibility, done independently under their own organization's guidelines, and outside the factory's scope (OQ-7). | Gate 1 #1 (S3.2, S9.4); OQ-7 | Accepted (owner, 2026-11-13) as a yes/no flag; changed in v9 to a list; re-approved (owner, 2026-11-13, decision card) |
| SR-9 | An endpoint rung is allowed only for a role whose role policy is read-only on the worktree (writing only its `.factory/` report) with no network beyond the gateway; any other role needs its own Security decision first. | Gate 1 #2 (S6.2, S8.1, S4.5) | Accepted (owner, 2026-11-13, decision card) |
| SR-10 | Advisory output reaches the Claude gate reviewer only as engine-validated structured data: findings (criterion id, severity, location, description capped at 500 characters) and a verdict word; anything else is dropped. The Claude prompt marks it as unverified hints, and the gate result comes only from the Claude reviewer's own report. | Gate 1 #3 (S6.1, S9.3) | Accepted (owner, 2026-11-13, decision card) |
| SR-11 | The engine records each endpoint model's name, parameter count, byte size and quant type (whatever the endpoint reports) at each check; any change counts as a new model, resets its calibration results and advisory match rate, and tells the owner. Residual: a swap keeping all of these the same is not detectable without a digest. | Gate 1 #4 (S4.1, S4.3) | Accepted (owner, 2026-11-13, decision card) |
| SR-16 | LiteLLM is a new external component (S4.1): before it is approved for use, a security review covers its source and maintainers, known CVEs, install and start-up scripts, the permissions it needs and what it pulls in, recorded with H-0139. It is pinned by image digest (S4.3), scanned for CVEs in CI and before each upgrade (S4.4), with S4.6 deadlines. **Its container holds the endpoint keys**, so it runs as a non-root user on a read-only file system, with no inbound access except from the gateway, no outbound access except through the egress proxy grant (FR-5), its admin UI, database and telemetry off, and a per-run master key. Its replies are untrusted: the gateway keeps its body size caps and FR-12 deadlines on them (S4.5, S5.1). | v13 delta #6 (S4.1, S4.3 to S4.6, S8.1, S8.4) | Accepted (owner, 2026-11-13, decision card) |
| SR-17 | LiteLLM conditions (OQ-9): LTS line only, pinned by image digest with its cosign signature verified against the key at a pinned LiteLLM commit; no release adopted until 14 days after publication unless it fixes a CVE in a feature the factory uses, never a floating tag; database, admin UI, MCP, SSO, guardrails, callbacks, caching and telemetry off; the gateway passes only the Anthropic Messages fields Claude Code sends and strips LiteLLM routing and credential parameters (`api_base`, `api_key`, `user_config`, provider credential fields, routing keys in `metadata`); endpoint keys rotated if a release the factory ran is later reported compromised, with the engine status naming them. Residual risk accepted: a bad release past these controls could misuse or leak the endpoint keys or alter replies, leaving only through the owner's endpoints. | S4.1 review (S4.1 to S4.6) | Accepted (owner, 2026-11-13, decision card) |
| SR-12 | Public endpoints must use HTTPS with certificate and host-name checks (TLS 1.2 or later) and an API key from the credential store; an `http://` URL or a missing key makes the endpoint unavailable (OWASP ASVS 5.0 V12, secure communication; NIST SP 800-53 SC-8, SC-23). | v9 delta #1 | Accepted (owner, 2026-11-13, decision card) |
| SR-13 | An endpoint's key is sent only to that endpoint, only in its auth header, and never on a redirect; the gateway follows no redirects from an endpoint (S8.2; CWE-522). | v9 delta #2 | Accepted (owner, 2026-11-13, decision card) |
| SR-14 | Every endpoint that costs money is bounded: `per_token` spend counts against the project budget and its run-cost estimate (prices required), and `subscription` use stops at its plan limits less the reserve; so a mispriced, misconfigured or looping agent can't run up an unbounded bill or exhaust the owner's plan (ADR 0012; OWASP LLM10, unbounded consumption). | v9 delta #3 | Accepted (owner, 2026-11-13, decision card) |
| SR-15 | Billing mode `local` (unlimited, uncounted) is allowed only for a private endpoint; a public endpoint must be `per_token` or `subscription`. | v9 delta #4 | Accepted (owner, 2026-11-13, decision card) |

## 10. Interface requirements
Approved by the owner 2026-11-13 (decision card), in their v13 form.
H-0135 to H-0137 and H-0139 are applied at build (H-0139 once the SR-16
review passes); H-0138 is applied in this PR as ADR 0019.

- **H-0135 (approved, Interfaces):** new contract *Model endpoints
  file v1.0* (`factory-endpoints.local.yaml`):
  `endpoints.<name>.base_url`, `.model`, `.api` (`anthropic` or `openai`, as LiteLLM names the provider), optional
  `.api_key_ref`, `.max_sessions` (default 1), `.billing` (`local`,
  `per_token` or `subscription`), `.prices.input_per_mtok` and
  `.prices.output_per_mtok` (for `per_token`), `.plan.limits[]` (each
  `{ kind: requests | input_tokens | output_tokens, count, window: 5h | day
  | week | month }`) and `.plan.reserve_pct` (default 10) (for
  `subscription`), optional `.deadline.margin_s`, and `.allow_loopback` (default
  false). Endpoint names: lower-case letters, digits and `-`, up to 32
  characters, not `anthropic`. Also Project manifest minor bump:
  `settings.endpoints` (list of endpoint names, default empty; SR-8).
- **H-0136 (approved, Interfaces):** Agent report minor bump: `model`
  may be `<endpoint>/<model>`; Tuning metrics and Calibration result group
  rungs by it, and the Run review records fallbacks (FR-7), advisory match
  rates (FR-10) and subscription plan usage (FR-13). Additive.
- **H-0137 (approved, Hygiene; file name updated):** `.gitignore` adds
  `/factory-endpoints.local.yaml`; CI check for AC-1.
- **H-0138 (approved, applied in this PR, Architecture):** [ADR
  0019](../adr/0019-model-endpoints-through-gateway.md), configured model
  endpoints as upstreams of the credential gateway.
- **H-0139 (approved, Architecture):** adopt LiteLLM as the factory's
  model router (OQ-8), pinned by image digest, after the S4.1 review in
  SR-16 passes; recorded in ADR 0019.

## 11. Readiness gate
Re-checked 2026-11-13 against spec v16.

- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable (AC-1 to AC-17)
- [x] Constraints documented (first endpoint measured 2026-11-13)
- [x] Assumptions explicit (A-1, A-2)
- [x] Blocking decisions resolved: OQ-1 to OQ-8 decided; SR-5 risk accepted; SR-1 to SR-16 approved; A-1, A-2 approved (A-1 checked in a spike before build); H-0135 to H-0139 approved, H-0138 applied

Before build: the SR-16 security review of LiteLLM, and the A-1 spike. A
failed review or spike sends the spec back to the owner. F-002 is not built
yet, so until it is, a role goes onto an endpoint rung only through
`engine/config/models.yaml` and a hygiene item (§ 2 item 5).

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft with OQ-1 to OQ-5, from the owner's request and a probe of the server | — |
| 2 | 2026-11-13 | OQ-1 decided (a): advisory first pass for gate roles, A-3 unchanged; FR-10 rewritten, FR-11 added | Owner, 2026-11-13 (decision card) |
| 3 | 2026-11-13 | OQ-3 decided (c): no key, plain HTTP, private-address pin only; SR-5 risk accepted | Owner, 2026-11-13 (decision card) |
| 4 | 2026-11-13 | OQ-2, OQ-4, OQ-5 decided (a): gateway upstream (ADR 0019), calibrate the gate and low-end roles first, fall back to the Claude rung after a 10-minute wait | Owner, 2026-11-13 (decision card) |
| 5 | 2026-11-13 | Security Gate 1 (`F-013-security-gate1.md`): 4 findings, none blocking; SR-8 to SR-11 proposed | — |
| 6 | 2026-11-13 | Owner: request timeouts scale with context size, measured. FR-7 split slot wait from request deadline; FR-12 and AC-11 added | Owner, 2026-11-13 (thread) |
| 7 | 2026-11-13 | SR-1 to SR-4 and SR-6 to SR-11 approved; A-1 and A-2 approved (A-1 checked in a spike before build) | Owner, 2026-11-13 (decision card) |
| 8 | 2026-11-13 | H-0135 to H-0138 approved; ADR 0019 applied; readiness gate passed | Owner, 2026-11-13 (decision card) |
| 9 | 2026-11-13 | Owner: any number of configurable endpoints, each with model and API key; `local` means unlimited usage. Rescoped from one local server: renamed, FR-2/4/13, AC-3/12/13, SR-12 to SR-15 and OQ-6/OQ-7 added; SR-1/3/5/8 rescoped; ADR 0019 generalized; Security Gate 1 delta; first endpoint's tool call and speed measured | Owner, 2026-11-13 (thread) for the rescope; changed items pending |
| 10 | 2026-11-13 | Owner: endpoints get a billing mode: `local`, `per_token` or `subscription` (plan limits with a reserve). FR-2, FR-13, SR-14, SR-15, H-0135 updated; AC-14 added | Owner, 2026-11-13 (thread) for the change; items pending |
| 11 | 2026-11-13 | OQ-6 decided (b): OpenAI chat-completions endpoints through a translator in the gateway; FR-14, FR-15 (fixture, stochastic round-trip and fuzz tests), AC-15 to AC-17, SR-16 added | Owner, 2026-11-13 (thread) |
| 12 | 2026-11-13 | OQ-7 decided (b): the project's endpoint list is the only control; evaluating an endpoint's terms and security is the user's, outside the factory. SR-8 reworded | Owner, 2026-11-13 (thread) |
| 13 | 2026-11-13 | OQ-8 decided (a): LiteLLM replaces the home-made translator and billing; § 1, § 2 item 4, FR-3, FR-5, FR-14, FR-15, AC-16, AC-17, A-1, SR-16 rewritten; H-0139 added | Owner, 2026-11-13 (thread, decision card) |
| 14 | 2026-11-13 | FR-14 clarified (owner asked): billing modes and accounting stay; LiteLLM only enforces the limits it can express, the engine does the rest | Owner, 2026-11-13 (thread) |
| 15 | 2026-11-13 | SR-12 to SR-16 approved; rescoped SR-1, SR-3, SR-5, SR-8 re-approved | Owner, 2026-11-13 (decision card) |
| 16 | 2026-11-13 | H-0135 to H-0139 and widened A-1 approved; ADR 0019 Accepted; readiness gate passed | Owner, 2026-11-13 (decision card) |
| 16 | 2026-11-13 | Spec v16 signed off; status Approved | Owner, 2026-11-13 (decision card, confirmed) |
| 17 | 2026-11-13 | Stage 5: S4.1 review of LiteLLM; OQ-9 decided (a), SR-17 added with its conditions and accepted residual risk | Owner, 2026-11-13 (decision card) |
| 18 | 2026-11-13 | A-1 spike: tool calls pass through LiteLLM in both formats; Claude Code fails on mid-conversation system messages with the server's template; OQ-10 opened | — |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Gate roles vs F-002 A-3. (a) Advisory first pass, Claude still decides. (b) Amend A-3. (c) Non-gate roles only. | Security | Decided (owner, 2026-11-13, decision card): (a); applies to every endpoint in v9 |
| OQ-2 | How agents reach an endpoint. (a) Through the credential gateway, chosen per session (ADR 0019). (b) Container network access. | Architecture | Decided (owner, 2026-11-13, decision card): (a) |
| OQ-3 | Securing the link to the LAN server. | Security | Decided (owner, 2026-11-13, decision card): (c) as is; v9 limits this to private endpoints (SR-5), public ones follow SR-12 |
| OQ-4 | Which roles to calibrate first. (a) Gate roles (advisory) and low-end roles. | Product | Decided (owner, 2026-11-13, decision card): (a) |
| OQ-5 | Busy or down. (a) 10-minute slot wait, then the role's Claude rung. | Product | Decided (owner, 2026-11-13, decision card): (a); request deadlines per FR-12 |
| OQ-6 | Which API formats endpoints may speak (now decided). Claude Code only speaks Anthropic Messages. (a) Anthropic Messages only in this feature; an OpenAI-only endpoint fails FR-6 with a clear message. `llama-server` and a growing number of servers and providers serve both. (b) Also OpenAI chat-completions, through a translator in the gateway that converts requests, tool calls and streaming both ways. **Recommended: (a)**: the translator would be new parsing code in the security-critical gateway, and tool-call translation is easy to get subtly wrong; it can be its own feature if a needed endpoint lacks the Anthropic format. | Architecture | Decided (owner, 2026-11-13, in the thread: "both should be supported"): (b); risk stated on the card and accepted; translation now done by LiteLLM (OQ-8) |
| OQ-7 | Sending code to a public, third-party endpoint. (a) Allowed per project only after a Security decision naming the endpoint, its operator and its data-retention and training terms; private endpoints need only the manifest list. (b) The manifest list alone for every endpoint. **Recommended: (a)**: a third party receiving a project's code is a new external service under S9.1 and widens access under S8.5, which the standards make the owner's Security decision. | Security | Decided (owner, 2026-11-13, in the thread): (b); "evaluating these things is outside the scope of the project. the user should evaluate terms and security of the endpoint/model independently and within their own organization's guidelines" |
| OQ-8 | Use an existing LLM gateway instead of building our own translator and billing? (a) LiteLLM in its own container behind the factory's gateway. (b) Build our own in the Node gateway. (c) Anthropic-format endpoints only. **Recommended: (a).** | Architecture | Decided (owner, 2026-11-13, in the thread and decision card): (a) |
| OQ-9 | The SR-16 review of LiteLLM ([F-013-litellm-review.md](F-013-litellm-review.md)) found two release compromises in 2026 and several Critical advisories. (a) Accept with six conditions and the residual risk. (b) A smaller proxy. (c) Anthropic-format endpoints only. (d) Our own translator. **Recommended: (a).** | Security | Decided (owner, 2026-11-13, decision card): (a); conditions in SR-17 |
| OQ-10 | A-1 spike failed: Claude Code sends a system message after the first user message, and the Qwen template on the owner's server rejects it (see [F-013-spike-a1.md](F-013-spike-a1.md)). (1) Wait for LiteLLM 1.109.x to clear quarantine (~25 Nov) and use its `supports_mid_conversation_system: false`. (2) Change the server's chat template. (3) The gateway folds later system messages into the next user message. (4) One-off spike on 1.109.1 now, ignoring quarantine. | Architecture | Open |
