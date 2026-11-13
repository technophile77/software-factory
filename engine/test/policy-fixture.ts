import { CHANGE_CONTROLLED_DENIES, CORE_ROLES, SECRET_DENIES, SOURCE_DOCUMENT_DENIES } from "../src/policy/role-policy";

type Role = Record<string, unknown>;

export const ANALYST: Role = {
  tools: { allow: ["Read", "Grep", "Glob", "Write", "Edit", "Skill"] },
  read: { allow: ["**"], deny: [...SECRET_DENIES] },
  write: { allow: ["docs/features/**"], deny: [...CHANGE_CONTROLLED_DENIES, ...SOURCE_DOCUMENT_DENIES] },
  commands: { allow: [] },
  network: { allow: [] },
};

export const READER: Role = {
  tools: { allow: ["fetch_page", "WebSearch"] },
  read: { allow: [], deny: [...SECRET_DENIES] },
  write: { allow: [] },
  commands: { allow: [] },
  network: { allow: ["*"] },
};

/** A manifest document with every core role and the two interview roles; placeholders only. */
export function policyDoc(over: Record<string, Role | undefined> = {}, repos: unknown[] = [{ name: "app", url: "https://github.com/example-org/app" }]): Record<string, unknown> {
  const roles: Record<string, Role> = {};
  for (const r of CORE_ROLES) roles[r] = { tools: { allow: ["Read"] }, read: { allow: ["**"], deny: [...SECRET_DENIES] } };
  roles["requirements-analyst"] = ANALYST;
  roles["web-reader"] = READER;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete roles[k];
    else roles[k] = v;
  }
  return { policy: { roles }, repos };
}
