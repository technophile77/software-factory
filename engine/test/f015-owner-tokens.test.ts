import { afterEach, describe, expect, it } from "vitest";
import { tokensToCheck } from "../src/build/token-check";
import { authorizeProject } from "../src/config/authorize";
import { ProjectTokens } from "../src/config/tokens";
import type { EngineHandle } from "../src/engine";
import { MemoryLogger } from "../src/log";
import { MemoryCredentialStore, SecretError, canonicalSecretName, factoryOwnerTokenName, isSecretName } from "../src/secrets";
import { FACTORY_TOKEN, ORG_ID, OWNER_ID, type World, makeWorld, manifestYaml, start } from "./helpers";
import { securityItemsIn } from "./inbox-items";

// F-015 FR-19: one token per GitHub owner of a project's repos.

const ORG_TOKEN = "github_pat_placeholder_other_org";

let engines: EngineHandle[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  engines = [];
});

async function boot(w: World) {
  const e = await start(w);
  engines.push(e);
  return e;
}

/** acme's code repo moved to `other-org`; the config repo stays with `example-org`. */
function twoOwners(): World {
  const manifest = manifestYaml({ extra: "" })
    .replace("https://github.com/example-org/acme-web", "https://github.com/other-org/acme-web")
    .replace(`allowed_repo_owners:\n  - { login: example-org, id: ${ORG_ID} }`, `allowed_repo_owners:\n  - { login: example-org, id: ${ORG_ID} }\n  - { login: other-org, id: ${OWNER_ID} }`);
  const w = makeWorld({ manifest });
  w.github.repos.set("other-org/acme-web", { status: 200, ownerId: OWNER_ID, private: true });
  return w;
}

describe("owner token names", () => {
  it("are factory-token/<project>/<login>, stored and read in lower case", () => {
    expect(factoryOwnerTokenName("mesbot", "MindsEyeSociety")).toBe("factory-token/mesbot/mindseyesociety");
    expect(isSecretName("factory-token/mesbot/MindsEyeSociety")).toBe(true);
    expect(canonicalSecretName("factory-token/mesbot/MindsEyeSociety")).toBe("factory-token/mesbot/mindseyesociety");
    expect(canonicalSecretName("factory-token/mesbot")).toBe("factory-token/mesbot");
  });

  it("refuse anything that isn't a GitHub login", () => {
    for (const bad of ["-lead", "a/b", "a b", "x".repeat(40), ""]) expect(() => factoryOwnerTokenName("mesbot", bad)).toThrow(SecretError);
    expect(isSecretName("factory-token/mesbot/a/b")).toBe(false);
    expect(isSecretName("factory-token/mesbot/")).toBe(false);
  });
});

describe("ProjectTokens", () => {
  it("AC-37: reads the default and the owners the project's repos have, never any other name", async () => {
    const store = new MemoryCredentialStore({ "factory-token/p": "d", "factory-token/p/org-a": "a", "factory-token/p/stray": "s" });
    const read: string[] = [];
    const get = store.get.bind(store);
    store.get = async (n: string) => (read.push(n), get(n));
    const t = await ProjectTokens.load(store, "p", ["Org-A", "user-b", "org-a"]);
    expect(read.sort()).toEqual(["factory-token/p", "factory-token/p/org-a", "factory-token/p/user-b"]);
    expect(t.for("ORG-A")).toBe("a");
    expect(t.for("user-b")).toBe("d");
    expect(t.nameFor("org-a")).toBe("factory-token/p/org-a");
    expect(t.nameFor("user-b")).toBe("factory-token/p");
  });
});

describe("authorizeProject with tokens per owner", () => {
  const manifest = (owners: string[]) => ({
    name: "p",
    allowed_repo_owners: [{ login: "x", id: 7 }],
    repos: owners.map((o, i) => ({ name: `r${i}`, url: "", owner: o, repo: `r${i}` })),
  }) as never;
  const github = () => {
    const calls: Array<[string, string]> = [];
    return { calls, repo: async (o: string, n: string, token: string) => (calls.push([`${o}/${n}`, token]), { status: 200, ownerId: 7, private: true }) } as never as { calls: Array<[string, string]> };
  };

  it("AC-35: each repo is checked with its owner's token, the config repo with the default", async () => {
    const gh = github();
    await authorizeProject(manifest(["org-a"]), gh as never, ProjectTokens.of("p", "d", { "org-a": "a" }), new MemoryLogger(), { owner: "user-b", repo: "cfg" });
    expect(gh.calls).toEqual([["org-a/r0", "a"], ["user-b/cfg", "d"]]);
  });

  it("AC-38: two owners on the default token fail, naming the store names to set", async () => {
    const run = authorizeProject(manifest(["org-a"]), github() as never, ProjectTokens.of("p", "d"), new MemoryLogger(), { owner: "user-b", repo: "cfg" });
    await expect(run).rejects.toThrow(/factory-token\/p\/org-a.*factory-token\/p\/user-b/);
  });

  it("AC-38: a single-owner project needs only the default token, as before", async () => {
    const gh = github();
    await authorizeProject(manifest(["user-b"]), gh as never, ProjectTokens.of("p", "d"), new MemoryLogger(), { owner: "user-b", repo: "cfg" });
    expect(gh.calls.map((c) => c[1])).toEqual(["d", "d"]);
  });
});

describe("the engine at start (F-015 FR-19)", () => {
  it("AC-38: a code repo of another owner without its own token stops the project with a Security item naming the token to store", async () => {
    const w = twoOwners();
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ state: "stopped" });
    expect(e.projects[0]!.reason).toContain("factory-token/acme/other-org");
    const items = securityItemsIn(w.config);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).not.toContain("github_pat_");
  });

  it("AC-35: with the owner's token stored, the code repo is reached with it and the config repo with the default", async () => {
    const w = twoOwners();
    await w.credentials.set("factory-token/acme/other-org", ORG_TOKEN);
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ state: "running" });
    expect(w.github.repoCalls).toContainEqual({ repo: "other-org/acme-web", token: ORG_TOKEN });
    const cfg = w.github.repoCalls.filter((c) => c.repo === "example-org/acme-config");
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.every((c) => c.token === FACTORY_TOKEN)).toBe(true);
  });
});

describe("tokensToCheck (F-015 FR-19, SR-2)", () => {
  const code = { token: "a", name: "factory-token/p/org-a", repo: "org-a/web" };
  const config = { token: "d", name: "factory-token/p", repo: "user-b/cfg" };

  it("AC-36: a config repo token that differs is checked too, on the config repo", () => {
    expect(tokensToCheck(code, config, () => false)).toEqual([code, config]);
  });

  it("one token for both repos is checked once, on the code repo, as before", () => {
    expect(tokensToCheck(code, { ...config, token: "a" }, () => false)).toEqual([code]);
  });

  it("a token already checked isn't checked again", () => {
    expect(tokensToCheck(code, config, (t) => t === "a")).toEqual([config]);
  });
});
