import YAML from "yaml";
import type { Endpoint } from "../config/endpoints";
import { DockerError } from "../docker/cli";
import { PROXY_PORT } from "../proxy/port";

/** Where the router listens inside its container. */
export const ROUTER_PORT = 4000;
/** The router's name on the internal network; the gateway and the proxy reach it here. */
export const ROUTER_ALIAS = "factory-router";
/** A per-request limit for LiteLLM, in seconds; the engine's own deadline policy ends a session sooner. */
export const ROUTER_TIMEOUT_S = 3600;

/** The part of a pinned endpoint the config needs; the address itself stays with the proxy. */
export interface LitellmPin {
  name: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  basePath: string;
}

/** The variable that carries endpoint number `index`'s API key into the router container. */
export function endpointKeyVar(index: number): string {
  return `FACTORY_EP_KEY_${index}`;
}

/**
 * The router's config file (F-013 FR-5, litellm review condition 3): one route
 * per endpoint and nothing else. The host name stays in `api_base` so TLS
 * checks still work; the egress proxy connects to the address it pinned, so
 * the name is never looked up again. Keys appear only as `os.environ/` refs,
 * so the file holds no secret and can be mounted from an ordinary folder.
 *
 * `supports_mid_conversation_system: false` makes LiteLLM move Claude Code's
 * later system messages to the top, which strict chat templates need (A-1 spike).
 *
 * @param endpoints the run's endpoints, in the order `litellmEnv` numbers their keys.
 * @param pins the resolved address parts, one per endpoint, matched by name.
 * @example
 * litellmConfig([lan], [{ name: "lan", scheme: "http", host: "llm.local", port: 8080, basePath: "" }]);
 * // model_list[0].litellm_params.api_base === "http://llm.example:8080"
 * @throws DockerError when an endpoint has no pin, or a name is repeated.
 * @see litellmEnv
 */
export function litellmConfig(endpoints: Endpoint[], pins: LitellmPin[]): string {
  if (new Set(endpoints.map((e) => e.name)).size !== endpoints.length) throw new DockerError("endpoint names must be unique");
  const model_list = endpoints.map((e, i) => {
    const pin = pins.find((p) => p.name === e.name);
    if (!pin) throw new DockerError("an endpoint has no pinned address");
    return {
      model_name: e.name,
      litellm_params: {
        model: `${e.api === "openai" ? "openai" : "anthropic"}/${e.model}`,
        api_base: `${pin.scheme}://${pin.host}:${pin.port}${pin.basePath}`,
        // A literal placeholder, not a credential: some providers' clients refuse an empty key.
        api_key: e.api_key_ref !== undefined ? `os.environ/${endpointKeyVar(i)}` : "none",
        timeout: ROUTER_TIMEOUT_S,
      },
      model_info: { supports_mid_conversation_system: false },
    };
  });
  return YAML.stringify({
    model_list,
    litellm_settings: { telemetry: false, drop_params: true, cache: false },
    general_settings: {
      master_key: "os.environ/LITELLM_MASTER_KEY",
      disable_spend_logs: true,
      store_model_in_db: false,
    },
  });
}

/**
 * The environment of the router container: the endpoint keys, the per-run
 * master key, and the egress proxy as its only way out. The proxy credential
 * is the router grant's, never an agent's and never the Claude credential.
 *
 * These values are visible to `docker inspect` on this PC and to every
 * process LiteLLM starts. FR-3 asks for the way the Claude credential is
 * handed over (stdin); the owner has not yet decided whether environment
 * delivery is acceptable (Gate 2 L3). Until then they go nowhere else: not the
 * config file, not a log, not an argument.
 *
 * The settings after NO_PROXY keep LiteLLM from reaching out or serving more
 * than model routes: no telemetry, no download of its model price map (which
 * the proxy would refuse and which delays start), no `.env` loading, no admin
 * UI or API docs.
 *
 * @param endpoints the same list given to `litellmConfig`.
 * @param keys API key values by `api_key_ref`.
 * @param masterKey the run's key for the router, which only the gateway holds.
 * @param proxyCred the router grant's credential at the egress proxy.
 * @example
 * litellmEnv([lan], new Map([["lan-key", "k"]]), mk, cred).FACTORY_EP_KEY_0; // "k"
 * @throws DockerError when an endpoint's `api_key_ref` has no value in `keys`.
 */
export function litellmEnv(endpoints: Endpoint[], keys: Map<string, string>, masterKey: string, proxyCred: string): Record<string, string> {
  const env: Record<string, string> = {};
  endpoints.forEach((e, i) => {
    if (e.api_key_ref === undefined) return;
    const key = keys.get(e.api_key_ref);
    if (key === undefined) throw new DockerError("an endpoint's API key isn't in the credential store");
    env[endpointKeyVar(i)] = key;
  });
  const proxy = `http://factory:${proxyCred}@factory-proxy:${PROXY_PORT}`;
  return {
    ...env,
    LITELLM_MASTER_KEY: masterKey,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: "",
    LITELLM_TELEMETRY: "False",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    LITELLM_MODE: "PRODUCTION",
    DISABLE_ADMIN_UI: "True",
    NO_DOCS: "True",
    NO_REDOC: "True",
  };
}
