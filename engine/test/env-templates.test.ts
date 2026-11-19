import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { unreadableUnder } from "../src/agent/session";
import { allowedBy, readableBy } from "../src/policy/glob";
import { SECRET_DENIES } from "../src/policy/role-policy";
import { tmpdir } from "./helpers";

const read = { allow: ["**"], deny: [...SECRET_DENIES] };

describe("Role policy v2.10 (H-0264): .env templates are readable", () => {
  it("reads .env.example, .env.sample and .env.template in any folder and any case", () => {
    for (const f of [".env.example", "app/.env.sample", "a/b/.env.template", ".ENV.Example"]) expect(readableBy(read, f), f).toBe(true);
  });

  it("still refuses every other .env file and every other secret file", () => {
    for (const f of [".env", ".env.local", ".env.production", ".env.example.local", "id_rsa", "k.pem"]) {
      expect(readableBy(read, f), f).toBe(false);
    }
  });

  it("the exception is only for reading: write rules are unchanged", () => {
    expect(allowedBy(read, ".env.example")).toBe(false);
  });

  it("only the **/.env.* deny is waived: a project's own deny of the template still holds", () => {
    expect(readableBy({ allow: ["**"], deny: [...SECRET_DENIES, "**/.env.example"] }, ".env.example")).toBe(false);
  });

  it("a whole-folder search no longer stops at a template, but still stops at a real .env file", () => {
    const wt = tmpdir();
    fs.mkdirSync(path.join(wt, "bot"));
    fs.writeFileSync(path.join(wt, "bot", "main.py"), "x\n");
    fs.writeFileSync(path.join(wt, ".env.example"), "TOKEN=changeme\n");
    expect(unreadableUnder(wt, "", read)).toBeNull();
    fs.writeFileSync(path.join(wt, ".env.local"), "TOKEN=real\n");
    expect(unreadableUnder(wt, "", read)).toBe(".env.local");
  });
});
