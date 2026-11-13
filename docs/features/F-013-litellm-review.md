# F-013 External component review: LiteLLM (S4.1, SR-16)

- **Component:** LiteLLM proxy (BerriAI/litellm), run as a container image
- **Purpose in the factory:** model router behind the credential gateway
  (F-013 OQ-8, H-0139, ADR 0019). Holds the endpoint API keys.
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Result:** **Conditional.** Usable only with the conditions below, and
  only with the owner accepting the stated residual risk (Security
  decision). Agents don't accept it for the owner (S4.6).
- **Owner decision:** accepted with all six conditions and the residual risk
  (owner, 2026-11-13, decision card, F-013 OQ-9 (a)).

## Findings

### 1. Release supply chain compromised twice in 2026 (S4.1, S4.3)
- **March 2026:** `litellm` 1.82.7 and 1.82.8 on PyPI carried a credential
  stealer, published with maintainer credentials stolen through a
  compromise of Trivy in LiteLLM's CI ([Datadog](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/),
  [GitHub issue #24518](https://github.com/BerriAI/litellm/issues/24518)).
- **21 October 2026:** 1.107.0 on PyPI **and the official Docker images**
  (`v1.107.0`, and for about two hours `latest`, `main-latest`,
  `main-stable`) carried a credential stealer and an hourly remote code
  loader. Attackers used stolen maintainer GitHub tokens to run the real
  release pipeline against a lookalike fork; a key leaked publicly in May
  was the reported entry point. The payload ran at every Python start and
  took, among other things, **LLM provider API keys from the proxy**
  ([StepSecurity](https://www.stepsecurity.io/blog/litellm-1-107-0-compromised-pypi-backdoored-wheels-credential-stealer),
  [Datadog](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-docker/)).
- Since 1.106.3, images are signed with cosign under a new key; the
  project advises verifying against the key at a pinned commit, not a tag
  ([releases](https://github.com/BerriAI/litellm/releases)).

This is the exact threat SR-16 names: a bad release in the container that
holds the keys.

### 2. Frequent serious vulnerabilities, two actively exploited (S4.2, S4.4)
LiteLLM's advisory list has 10 entries from May to November 2026, three
Critical ([advisories](https://github.com/BerriAI/litellm/security/advisories)).
Examples:
- CVE-2026-42271, command injection through MCP test endpoints, fixed in
  1.83.7, on CISA's Known Exploited Vulnerabilities list since 8 June 2026
  ([Help Net Security](https://www.helpnetsecurity.com/2026/06/09/litellm-vulnerability-under-active-attack-cisa-warns-cve-2026-42271/)).
- An MCP authentication bypass (CVE-2026-59822) reported as added to the KEV
  list in September 2026 (single secondary source, not cross-checked).
- GHSA-4xpc-pv4p-pm3w, authentication bypass via Host header (Critical);
  GHSA-7hp6-4w63-5g45, escalation to proxy admin (Critical);
  GHSA-w4c7-34wj-hqm8, unauthenticated file read leaking the master key on
  the Enterprise proxy (Critical); GHSA-2rwg-2wh4-7c4f, authenticated
  secret exfiltration through Azure credential parameters (High, 12 Nov
  2026); two SSRF advisories that exfiltrate provider credentials through
  request-body routing parameters (Moderate).

Most of these sit in features the factory doesn't use (MCP, admin UI, SSO,
database, Enterprise, Azure/Vertex credentials). The request-body routing
and SSRF ones are in the request path the factory does use.

### 3. High release churn (S4.6)
Several releases a day, with security backports across lines (1.106.x,
1.108.x LTS, 1.109.x). Keeping within S4.6 deadlines means regular
upgrades, each needing FR-15's conformance run.

## Why it can still fit
The factory's design limits what a bad LiteLLM can do:
- It never sees the Claude credential (FR-3), only endpoint keys.
- Its only outbound path is the egress proxy grant to the configured
  endpoints (FR-5). The October stealer's exfiltration to `litellm.dev`,
  and the hourly loader's fetch, would both be refused.
- Only the gateway can reach it, with a per-run master key; agents can't
  send it requests directly, which blocks the request-body SSRF and
  parameter attacks unless the gateway passes them on.
- A read-only file system stops the `.pth` persistence the payloads used.

## Conditions (all needed)
1. **LTS line only** (currently 1.108.x), pinned by image digest in the
   master repo; the digest's cosign signature is verified against the key
   at a pinned LiteLLM commit before the engine runs it.
2. **Quarantine:** a new release is adopted no sooner than 14 days after it
   is published, unless it fixes a CVE in a feature the factory uses; never
   from a floating tag.
3. **Features off:** no database, admin UI, MCP, SSO, guardrails, callbacks,
   caching or telemetry; only the proxy's model routes.
4. **Gateway allow list of request fields:** the gateway passes LiteLLM only
   the Anthropic Messages fields Claude Code sends, and strips LiteLLM-
   specific routing and credential parameters (`api_base`, `api_key`,
   `user_config`, provider credential fields, `metadata` routing keys), so
   the request-body SSRF and secret-exfiltration advisories can't be reached.
5. Locked-down container as SR-16 says, and the CVE scan in CI.
6. **Key rotation plan:** if any LiteLLM release the factory ran is later
   reported compromised, every endpoint key it held is rotated; the engine
   status names the keys involved.

## Residual risk for the owner
Even with these conditions, a compromised LiteLLM release that gets past the
pin, signature and quarantine could misuse or leak the endpoint keys it
holds, and could alter model replies. The egress limit stops it reaching
anything but your endpoints, so stolen keys would have to leave through one
of those endpoints, which is unlikely but not impossible. The project's
record (two release compromises and several Critical advisories in 2026)
makes this likelier than for a typical dependency.

## Alternatives, if the owner declines
- A smaller single-purpose proxy, reviewed the same way.
- The factory's own translator in the Node gateway (F-013 v12 design): no
  new dependency, but more of our own code to secure and maintain.
- Anthropic-format endpoints only, with no translation (the owner's LAN
  server already speaks it).
