import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { serve } from "../src/channel/framing";
import { listenPipe } from "../src/channel/windows";
import { SessionManager } from "../src/channel/sessions";
import { credentialKind } from "../src/config/authorize";
import { type InterviewSignIn, interviewSignIn, validateManifest } from "../src/config/manifest";
import { ConfigError, readPathsFile } from "../src/config/paths-file";
import { comparePin, pinnedKeys } from "../src/config/pins";
import { Git, overrideArgs } from "../src/git";
import { HttpGitHub, parseDeviceCode, parsePoll, startDeviceApproval } from "../src/github";
import { Gitleaks, ScanError } from "../src/gitleaks";
import { frameTurn } from "../src/interview/frame";
import { FileLogger, MemoryLogger } from "../src/log";
import { CredentialApi, FfiError, FUNCTIONS, Handle, OsApi, WindowsApi, realOsApi } from "../src/os/ffi";
import { isOwnerOnlyPipe, isOwnerWritableOnly, ownerOnlyPipeSddl, parseSddl, withSelfSid } from "../src/os/sddl";
import { Children, osParent, osStartOrder } from "../src/proc";
import { MemoryCredentialStore, OsCredentialStore, SecretError, factoryTokenName } from "../src/secrets";
import { EngineRecord } from "../src/state/record";
import { RunBook, transcriptSummary } from "../src/state/runs";
import { SecretFound, StateRepo, blobId, checkStatePath } from "../src/state/state-repo";
import { ChainError, canonical, checkAgainstHead, makeEntry, parseTranscript, serialize } from "../src/state/transcript";
import { InterviewState } from "../src/interview/model";
import { canSymlink, needsSymlinks, nodeProgram, ownerOnly } from "./acceptance/support/platform";
import { CLIENT_ID, GIT_PATH, FakeClock, FakeGitHub, OWNER_ID, fakeGitleaks, git, initRepo, manifestYaml, settle, tmpdir } from "./helpers";
import { systemClock } from "../src/clock";

const linuxOs: OsApi = {
  platform: "linux",
  unix: () => ({ geteuid: () => process.geteuid!(), peerCred: () => ({ uid: 0, pid: 1 }) }),
  windows: () => {
    throw new FfiError("x");
  },
  credentials: () => {
    throw new FfiError("x");
  },
};

describe("secrets (SR-20, OQ-7)", () => {
  class FakeApi implements CredentialApi {
    store = new Map<string, Buffer>();
    fail = false;
    read(s: string, a: string) {
      if (this.fail) throw new FfiError("read");
      return this.store.get(`${s}|${a}`) ?? null;
    }
    write(s: string, a: string, v: Buffer) {
      if (this.fail) throw new FfiError("write");
      this.store.set(`${s}|${a}`, Buffer.from(v));
    }
    remove(s: string, a: string) {
      return this.store.delete(`${s}|${a}`);
    }
  }

  it("stores under the factory's own service name, only for the fixed secret names", async () => {
    const api = new FakeApi();
    const s = new OsCredentialStore(() => api);
    await s.set("model-credential", "sk-ant-oat01-x");
    await s.set(factoryTokenName("acme"), "ghp_x");
    expect([...api.store.keys()]).toEqual(["software-factory-engine|model-credential", "software-factory-engine|factory-token/acme"]);
    expect(await s.get("model-credential")).toBe("sk-ant-oat01-x");
    await expect(s.get("anything-else")).rejects.toThrow(SecretError);
    await expect(s.set("model-credential", "two words")).rejects.toThrow(SecretError);
    await expect(s.set("model-credential", "")).rejects.toThrow(SecretError);
    expect(() => factoryTokenName("../x")).toThrow(SecretError);
    expect(await s.delete("model-credential")).toBe(true);
    expect(await s.get("model-credential")).toBeNull();
  });

  it("fails closed when the OS store fails, and never echoes the secret", async () => {
    const api = new FakeApi();
    api.fail = true;
    const s = new OsCredentialStore(() => api);
    await expect(s.get("model-credential")).rejects.toThrow("The OS credential store couldn't be read.");
    const e = await s.set("model-credential", "sk-ant-oat01-secretvalue").catch((x: Error) => x);
    expect((e as Error).message).not.toContain("secretvalue");
    const throwing = new OsCredentialStore(() => {
      throw new FfiError("libsecret missing");
    });
    await expect(throwing.get("model-credential")).rejects.toThrow(SecretError);
  });

  it("refuses a malformed stored value", async () => {
    const api = new FakeApi();
    api.store.set("software-factory-engine|model-credential", Buffer.from("bad value\n"));
    await expect(new OsCredentialStore(() => api).get("model-credential")).rejects.toThrow(/malformed/);
  });

  it("AC-4 ancestry: each OS walks parents through its own lookup, and a missing lookup fails closed", () => {
    const fake = (platform: NodeJS.Platform, parents: Record<number, number>) => ({
      platform,
      unix: () => ({ parentPid: (p: number) => parents[p] ?? null }),
      windows: () => ({ parentPid: (p: number) => parents[p] ?? null }),
    });
    for (const platform of ["darwin", "win32"] as const) {
      // A grandchild of the engine, by ancestry.
      const kids = new Children(osParent(fake(platform, { 900: 800, 800: process.pid })));
      expect(kids.startedByEngine(900)).toBe(true);
      expect(new Children(osParent(fake(platform, { 900: 1 }))).startedByEngine(900)).toBe(false);
      const blind = osParent({ platform, unix: () => ({}), windows: () => ({}) });
      expect(() => new Children(blind).startedByEngine(900)).toThrow();
    }
  });

  it("a recorded parent pid that one of our children took over after the parent exited isn't ancestry", () => {
    // The client (pid 900) was started by a process that has exited; Windows gave its pid, 700, to a git reader of ours.
    const parents: Record<number, number> = { 900: 700, 700: process.pid };
    const started: Record<number, number> = { 900: 100, 700: 500 };
    const kids = new Children((p) => parents[p] ?? null, (p) => started[p] ?? null);
    kids.add(700);
    expect(kids.startedByEngine(900)).toBe(false);
    // A real child of ours, started before its own child, still counts, as does an unknown start time.
    started[700] = 50;
    expect(kids.startedByEngine(900)).toBe(true);
    expect(new Children((p) => parents[p] ?? null, () => null).startedByEngine(900)).toBe(true);
    // The reused pid can belong to a grandchild, such as the git behind a Git for Windows launcher (600, ours).
    const tree: Record<number, number> = { 900: 701, 701: 600, 600: process.pid };
    const born: Record<number, number> = { 900: 100, 701: 500, 600: 400 };
    const grand = new Children((p) => tree[p] ?? null, (p) => born[p] ?? null);
    grand.add(600);
    expect(grand.startedByEngine(900)).toBe(false);
    expect(grand.lastChain).toEqual([900, 701]);
    // A real grandchild of ours, younger than each parent, is refused.
    born[900] = 900;
    expect(grand.startedByEngine(900)).toBe(true);
    // A pid still listed after its process ended is no parent either.
    const stale = new Children((p) => (p === 900 ? 700 : null));
    stale.add(700);
    expect(stale.startedByEngine(900)).toBe(false);
    // Only Windows looks at start times, and a failed lookup gives no answer instead of an error.
    expect(osStartOrder({ platform: "linux", windows: () => ({}) })).toBeUndefined();
    const failing = osStartOrder({ platform: "win32", windows: () => ({ startOrder: () => { throw new Error("x"); } }) })!;
    expect(failing(900)).toBeNull();
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")("the real parent lookup reports this process's parent", () => {
    const os = realOsApi();
    const api = process.platform === "win32" ? os.windows() : os.unix();
    expect(api.parentPid!(process.pid)).toBe(process.ppid);
    expect(api.parentPid!(2 ** 31 - 2)).toBeNull();
    if (process.platform === "win32") {
      const win = os.windows();
      const mine = win.startOrder!(process.pid);
      const parent = win.startOrder!(process.ppid);
      expect(mine).toBeGreaterThan(0);
      expect(parent).toBeLessThan(mine!);
      expect(win.startOrder!(2 ** 31 - 2)).toBeNull();
    }
  });

  it.runIf(process.platform === "win32")("Windows ranks a child and a grandchild strictly after their parents (Gate 2 L10)", async () => {
    const win = realOsApi().windows();
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)']);console.log(c.pid);setTimeout(()=>c.kill(),20000)";
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let grandchild = 0;
    try {
      grandchild = await new Promise<number>((resolve, reject) => {
        child.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
        child.once("error", reject);
      });
      const ranks = [process.pid, child.pid!, grandchild].map((p) => win.startOrder!(p));
      for (const r of ranks) expect(Number.isSafeInteger(r)).toBe(true);
      expect(ranks[0]!).toBeLessThan(ranks[1]!);
      expect(ranks[1]!).toBeLessThan(ranks[2]!);
    } finally {
      if (grandchild) {
        try {
          process.kill(grandchild);
        } catch {
          // already gone
        }
      }
      child.kill();
    }
  });

  it("the FFI module declares a fixed list of functions per OS", () => {
    expect(Object.keys(FUNCTIONS)).toEqual(["linux", "darwin", "win32"]);
    expect(FUNCTIONS.linux["libc.so.6"]).toEqual(["geteuid", "getsockopt"]);
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "os", "ffi.ts"), "utf8");
    for (const f of fs.readdirSync(path.join(__dirname, "..", "src"), { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f.endsWith(path.join("os", "ffi.ts"))) continue;
      expect(fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).not.toMatch(/from "koffi"/);
    }
    expect(src).toMatch(/import koffi from "koffi"/);
  });

  it("model credential kind follows ADR 0012: an API key in the environment wins", () => {
    expect(credentialKind({ ANTHROPIC_API_KEY: "x" }, "sk-ant-oat01-x")).toBe("api_key");
    expect(credentialKind({}, "sk-ant-oat01-x")).toBe("subscription");
    expect(credentialKind({}, "sk-ant-api03-x")).toBe("api_key");
    expect(credentialKind({}, "something")).toBeNull();
    expect(credentialKind({ CLAUDE_CODE_OAUTH_TOKEN: "x" }, null)).toBe("subscription");
  });

  it("MemoryCredentialStore has the same name rules", async () => {
    await expect(new MemoryCredentialStore().set("x", "y")).rejects.toThrow(SecretError);
  });
});

describe("SDDL (SR-15, SR-13 on Windows)", () => {
  const me = "S-1-5-21-1-2-3-1001";
  it("accepts only a protected, owner-only pipe DACL", () => {
    expect(ownerOnlyPipeSddl(me)).toBe(`D:P(A;;GA;;;${me})`);
    expect(isOwnerOnlyPipe(`O:${me}D:P(A;;FA;;;${me})`, me)).toBe(true);
    expect(isOwnerOnlyPipe(`D:(A;;FA;;;${me})`, me)).toBe(false);
    expect(isOwnerOnlyPipe(`D:P(A;;FA;;;${me})(A;;FR;;;WD)`, me)).toBe(false);
    expect(isOwnerOnlyPipe(`D:P(A;;FA;;;${me})(A;;FR;;;S-1-1-0)`, me)).toBe(false);
    expect(isOwnerOnlyPipe("D:P", me)).toBe(false);
    expect(isOwnerOnlyPipe(`D:P(XA;;FA;;;${me})`, me)).toBe(false);
    expect(isOwnerOnlyPipe("garbage", me)).toBe(false);
    expect(() => ownerOnlyPipeSddl("x)(A;;GA;;;WD")).toThrow();
  });

  it("a file writable only by the owner, SYSTEM and Administrators", () => {
    expect(isOwnerWritableOnly(`O:${me}D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${me})(A;;0x1200a9;;;BU)`, me)).toBe(true);
    expect(isOwnerWritableOnly(`O:${me}D:(A;;FA;;;${me})(A;;FW;;;BU)`, me)).toBe(false);
    expect(isOwnerWritableOnly(`O:${me}D:(A;;FA;;;${me})(A;;CCDC;;;AU)`, me)).toBe(false);
    expect(isOwnerWritableOnly(`O:BAD:(A;;FA;;;${me})`, me)).toBe(false);
    expect(isOwnerWritableOnly(`O:${me}D:(A;OICIIO;GA;;;CO)(A;;FA;;;${me})`, me)).toBe(true);
    expect(isOwnerWritableOnly(`O:${me}D:(A;;ZZ;;;${me})`, me)).toBe(false);
    expect(parseSddl(`O:SYD:(A;;GA;;;BA)`).owner).toBe("S-1-5-18");
  });

  it("M2: fails closed on a NULL DACL, conditional, object or audit ACEs, unknown flags and trailing text", () => {
    const cases = {
      nullDacl: `O:${me}D:NO_ACCESS_CONTROL`,
      nullDaclProtected: `O:${me}D:PNO_ACCESS_CONTROL`,
      conditional: `O:${me}D:(A;;FA;;;${me})(XA;;FA;;;WD;(Member_of {SID(WD)}))`,
      conditionalPipe: `D:P(A;;GA;;;${me})(XA;;GA;;;WD;(Member_of {SID(WD)}))`,
      objectAce: `O:${me}D:(A;;FA;;;${me})(OA;;FA;;;WD)`,
      objectGuid: `O:${me}D:(A;;FA;00000000-0000-0000-0000-000000000000;;;WD)`,
      auditAce: `O:${me}D:(A;;FA;;;${me})(AU;SA;FA;;;WD)`,
      trailingJunk: `O:${me}D:P(A;;GA;;;${me})garbage(A;;GA;;;WD)`,
      trailingAfterAces: `O:${me}D:P(A;;GA;;;${me})x`,
      unknownDaclFlag: `O:${me}D:PZ(A;;GA;;;${me})`,
      unknownAceFlag: `O:${me}D:(A;ZZ;FA;;;${me})`,
      sacl: `O:${me}D:P(A;;GA;;;${me})S:(ML;;NW;;;LW)`,
      badTrustee: `O:${me}D:P(A;;GA;;;${me}x)`,
    };
    for (const [k, v] of Object.entries(cases)) {
      expect(() => parseSddl(v), k).toThrow();
      expect(isOwnerWritableOnly(v, me), k).toBe(false);
      expect(isOwnerOnlyPipe(v, me), k).toBe(false);
    }
    // What Windows writes for the engine's own objects still passes.
    expect(isOwnerWritableOnly(`O:${me}G:SYD:PAI(A;OICIID;FA;;;SY)(A;;FA;;;${me})`, me)).toBe(true);
    expect(isOwnerOnlyPipe(`O:${me}G:${me}D:P(A;;GA;;;${me})`, me)).toBe(true);
  });

  it("machine-relative aliases resolve only to the current user, as Windows writes it", () => {
    // The Windows runner's built-in Administrator: Windows writes its SID as LA.
    const admin = "S-1-5-21-1111111111-2222222222-3333333333-500";
    const runner = "O:LAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)";
    const asSelf = (s: string) => withSelfSid(s, "LA", admin);
    expect(asSelf(runner)).toBe(`O:${admin}D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${admin})`);
    expect(isOwnerWritableOnly(asSelf(runner), admin)).toBe(true);
    expect(isOwnerOnlyPipe(asSelf("O:LAD:P(A;;GA;;;LA)"), admin)).toBe(true);
    // Unexpanded, LA can't be trusted: its machine prefix isn't in the text.
    expect(isOwnerWritableOnly(runner, admin)).toBe(false);
    // Any other machine- or domain-relative principal stays unresolved: never the owner, never trusted to write.
    expect(isOwnerWritableOnly(asSelf(runner.replace("O:LA", "O:LG")), admin)).toBe(false);
    expect(isOwnerWritableOnly(asSelf("O:LAD:(A;;FA;;;LA)(A;;FW;;;DU)"), admin)).toBe(false);
    expect(isOwnerWritableOnly(asSelf("O:LAD:(A;;FA;;;LA)(A;;FR;;;DU)"), admin)).toBe(true);
    expect(isOwnerOnlyPipe(asSelf("O:LAD:P(A;;GA;;;DA)"), admin)).toBe(false);
    expect(parseSddl("O:LGD:(A;;FA;;;DA)")).toMatchObject({ owner: "unresolved:LG", aces: [{ sid: "unresolved:DA" }] });
    // Only whole trustee and owner fields change; rights such as "LA" can't appear, and flags are untouched.
    expect(asSelf("O:BAD:(A;OICI;FA;;;LA)")).toBe(`O:BAD:(A;OICI;FA;;;${admin})`);
    // A user Windows writes as a plain SID is unaffected, and a fixed alias is never taken as the user.
    expect(withSelfSid(`O:${me}D:(A;;FA;;;${me})`, me, me)).toBe(`O:${me}D:(A;;FA;;;${me})`);
    expect(() => withSelfSid(runner, "BA", admin)).toThrow();
    expect(() => withSelfSid(runner, "LA", "x")).toThrow();
    expect(parseSddl("O:BUD:(A;;FA;;;AU)").aces[0]!.sid).toBe("S-1-5-11");
  });
});

describe("Windows pipe listener through a fake WindowsApi", () => {
  const me = "S-1-5-21-1-2-3-1001";
  function fakeWin(o: { sddl?: string; clientSid?: string; clientPid?: number } = {}) {
    const connects: Array<() => void> = [];
    const inbox: Buffer[] = [];
    const written: Buffer[] = [];
    let closed = 0;
    const api: WindowsApi = {
      currentUserSid: () => me,
      createPipe: () => ({}) as Handle,
      handleSddl: () => o.sddl ?? `D:P(A;;FA;;;${me})`,
      fileSddl: () => "",
      connectPipe: () => new Promise<void>((r) => connects.push(r)),
      pipeClientPid: () => o.clientPid ?? 777,
      processUserSid: () => o.clientSid ?? me,
      pipeAvailable: () => inbox.reduce((n, b) => n + b.length, 0),
      readPipe: () => Buffer.concat(inbox.splice(0)),
      writePipe: (_h, d) => void written.push(d),
      closePipe: () => void closed++,
      openPipeClient: () => {
        throw new Error("the listener never opens a client end");
      },
      pipeServerPid: () => 0,
      closeHandle: () => undefined,
    };
    return { api, connects, inbox, written, closed: () => closed };
  }

  it("refuses to serve when the ACL read back isn't owner-only", async () => {
    const f = fakeWin({ sddl: `D:P(A;;FA;;;${me})(A;;FR;;;WD)` });
    await expect(listenPipe({ os: f.api, children: new Children(), log: new MemoryLogger(), onConnection: () => undefined })).rejects.toThrow(/ACL/);
  });

  it("serves an owner client and refuses another user's", async () => {
    for (const [sid, served] of [[me, true], ["S-1-5-21-9-9-9-500", false]] as const) {
      const f = fakeWin({ clientSid: sid });
      const log = new MemoryLogger();
      let conns = 0;
      const l = await listenPipe({
        name: "\\\\.\\pipe\\software-factory-test", os: f.api, children: new Children(), log,
        onConnection: (c) => {
          conns++;
          serve(c, async () => ({ ok: true }), () => undefined);
        },
      });
      f.connects.shift()!();
      await settle();
      if (served) {
        f.inbox.push(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"x"}\n'));
        await new Promise((r) => setTimeout(r, 40));
        expect(Buffer.concat(f.written).toString()).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
      } else {
        expect(log.text()).toMatch(/isn't the owner/);
      }
      expect(conns).toBe(served ? 1 : 0);
      await l.close();
    }
  });
});

describe("GitHub device flow (SR-23, ADR 0014)", () => {
  const good = { device_code: "a".repeat(40), user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };

  it("validates every field of the device code answer", () => {
    expect(parseDeviceCode(good)).toEqual({ deviceCode: good.device_code, userCode: "WDJB-MJHT", verificationUri: good.verification_uri, expiresIn: 900, interval: 5 });
    for (const bad of [
      { user_code: "wdjb-mjht" }, { user_code: "WDJBMJHT" }, { verification_uri: "https://github.com/login/device/" },
      { verification_uri: "https://evil.example/login/device" }, { expires_in: 901 }, { expires_in: 0 }, { interval: "5" },
      { device_code: "x y" }, { device_code: undefined },
    ]) {
      expect(() => parseDeviceCode({ ...good, ...bad })).toThrow();
    }
  });

  it("reads poll answers and refuses unknown errors and malformed tokens", () => {
    expect(parsePoll({ error: "authorization_pending" })).toEqual({ kind: "pending" });
    expect(parsePoll({ error: "slow_down", interval: 10 })).toEqual({ kind: "slow_down", interval: 10 });
    expect(parsePoll({ error: "access_denied" })).toEqual({ kind: "denied" });
    expect(parsePoll({ error: "expired_token" })).toEqual({ kind: "expired" });
    expect(parsePoll({ access_token: "gho_abc", token_type: "bearer" })).toEqual({ kind: "token", token: "gho_abc" });
    expect(() => parsePoll({ access_token: "a b" })).toThrow();
    expect(() => parsePoll({ error: "unsupported_grant_type" })).toThrow();
    expect(() => parsePoll(null)).toThrow();
  });

  it("talks to a fake GitHub over HTTP: no scope, numeric id compared, token never logged", async () => {
    const seen: Array<{ url: string; body: string; auth?: string }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ url: req.url!, body, auth: req.headers.authorization });
        res.setHeader("content-type", "application/json");
        if (req.url === "/login/device/code") return res.end(JSON.stringify(good));
        if (req.url === "/login/oauth/access_token") return res.end(JSON.stringify({ access_token: "gho_secretvalue", token_type: "bearer" }));
        if (req.url === "/user") return res.end(JSON.stringify({ id: OWNER_ID, login: "someone-else-named-like-owner" }));
        if (req.url === "/repos/example-org/acme-web") return res.end(JSON.stringify({ owner: { id: 5 }, private: true }));
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const log = new MemoryLogger();
    const gh = new HttpGitHub({ webBase: base, apiBase: base, log });
    const clock = new FakeClock();
    const ac = new AbortController();
    const p = await startDeviceApproval({ github: gh, clientId: CLIENT_ID, ownerId: OWNER_ID, clock, signal: ac.signal, log, approvalId: "t#1" });
    expect(p.userCode).toBe("WDJB-MJHT");
    await clock.advance(5000);
    for (let i = 0; i < 50 && seen.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await p.result).toEqual({ approved: true });
    expect(seen[0]).toMatchObject({ url: "/login/device/code", body: `client_id=${encodeURIComponent(CLIENT_ID)}` });
    expect(seen[1]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(seen[2]).toMatchObject({ url: "/user", auth: "Bearer gho_secretvalue" });
    expect(log.text()).not.toContain("gho_secretvalue");
    expect(log.text()).not.toContain(good.device_code);
    expect(await gh.repo("example-org", "acme-web", "t")).toEqual({ status: 200, ownerId: 5, private: true });
    expect(await gh.repo("example-org", "missing", "t")).toEqual({ status: 404 });
    srv.close();
    expect(() => new HttpGitHub({ webBase: "http://github.com", log })).toThrow(/https/);
  });

  it("fails closed when GitHub is unreachable", async () => {
    const gh = new HttpGitHub({ webBase: "http://127.0.0.1:1", apiBase: "http://127.0.0.1:1", log: new MemoryLogger() });
    await expect(gh.requestDeviceCode(CLIENT_ID)).rejects.toThrow(/unreachable/);
  });

  it("a code that expires before approval fails", async () => {
    const gh = new FakeGitHub();
    gh.deviceAnswer = { expiresIn: 10, interval: 5 };
    const clock = new FakeClock();
    const p = await startDeviceApproval({ github: gh, clientId: CLIENT_ID, ownerId: OWNER_ID, clock, signal: new AbortController().signal, log: new MemoryLogger(), approvalId: "x" });
    await clock.advance(15_000);
    expect(await p.result).toEqual({ approved: false, reason: "expired" });
  });

  it("sessions never share approvals across projects (SR-16)", async () => {
    const gh = new FakeGitHub();
    const clock = new FakeClock();
    const a = new SessionManager("a", { githubId: OWNER_ID, oauthClientId: CLIENT_ID }, gh, clock, new MemoryLogger());
    const b = new SessionManager("b", { githubId: OWNER_ID, oauthClientId: CLIENT_ID }, gh, clock, new MemoryLogger());
    const s = await a.open("F-001", false);
    gh.approver = OWNER_ID;
    await clock.advance(5000);
    for (let i = 0; i < 20; i++) await settle();
    expect(a.approved(s.session).feature).toBe("F-001");
    expect(() => b.get(s.session)).toThrow(/Unknown or expired/);
  });

  describe("sign-in setting (F-018 FR-13, FR-15)", () => {
    const setup = (signIn: InterviewSignIn) => {
      const gh = new FakeGitHub();
      const clock = new FakeClock();
      const recorded: Array<[string, number, boolean]> = [];
      const m = new SessionManager("a", { githubId: OWNER_ID, oauthClientId: CLIENT_ID }, gh, clock, new MemoryLogger(),
        async (f, no, signedIn) => void recorded.push([f, no, signedIn]), signIn);
      const approve = async (token: string) => {
        gh.approver = OWNER_ID;
        await clock.advance(5000);
        for (let i = 0; i < 20; i++) await settle();
        gh.approver = null;
        return m.approved(token);
      };
      return { gh, clock, m, recorded, approve };
    };

    it("never: every open, takeovers included, is approved with no sign-in and recorded as such", async () => {
      const { gh, m, recorded } = setup({ every: "never" });
      const first = await m.open("F-001", false);
      expect(first.approval).toBeUndefined();
      expect(m.approved(first.session).feature).toBe("F-001");
      const taken = await m.open("F-001", true);
      expect(taken.approval).toBeUndefined();
      expect(() => m.approved(first.session)).toThrow();
      expect(recorded).toEqual([["F-001", 1, false], ["F-001", 2, false]]);
      expect(gh.deviceCalls).toBe(0);
    });

    it("session: each open, takeovers included, needs its own sign-in", async () => {
      const { m, approve } = setup({ every: "session" });
      const s1 = await m.open("F-002", false);
      expect(s1.approval).toBeDefined();
      expect(() => m.approved(s1.session)).toThrow(/approval/);
      await approve(s1.session);
      const s2 = await m.open("F-002", true);
      expect(s2.approval).toBeDefined();
      const s3 = await m.open("F-003", false);
      expect(s3.approval).toBeDefined();
    });

    it("engine_start: one sign-in covers later sessions of the run; a failed one covers nothing", async () => {
      const { gh, m, recorded, approve } = setup({ every: "engine_start" });
      const s1 = await m.open("F-001", false);
      expect(s1.approval).toBeDefined();
      m.close(s1.session);
      const s2 = await m.open("F-001", false);
      expect(s2.approval).toBeDefined();
      await approve(s2.session);
      const s3 = await m.open("F-002", false);
      expect(s3.approval).toBeUndefined();
      expect(m.approved(s3.session).feature).toBe("F-002");
      expect(recorded).toEqual([["F-001", 2, true], ["F-002", 3, false]]);
      expect(gh.deviceCalls).toBe(2);
    });

    it("hours: sessions within the window open without sign-in; the first after it signs in again", async () => {
      const { clock, m, approve } = setup({ every: "hours", hours: 4 });
      const s1 = await m.open("F-001", false);
      await approve(s1.session);
      await clock.advance(3 * 3_600_000);
      expect((await m.open("F-002", false)).approval).toBeUndefined();
      await clock.advance(3_600_000);
      expect((await m.open("F-003", false)).approval).toBeDefined();
    });
  });
});

describe("gitleaks (Gate 1 component review 5)", () => {
  it("runs dir mode with exactly the approved flags, from an empty folder, without GITLEAKS_* variables", async () => {
    const root = tmpdir();
    const fake = fakeGitleaks(path.join(root, "bin"));
    process.env.GITLEAKS_CONFIG = "/tmp/evil.toml";
    const g = new Gitleaks({ binary: fake.path, workDir: path.join(root, "work"), children: new Children(), expectSha256: fake.sha256, timeoutS: 60 });
    const r = await g.scan([{ sha: "a".repeat(40), content: Buffer.from("hello") }]);
    delete process.env.GITLEAKS_CONFIG;
    expect(r).toEqual({ clean: true });
    const args = fs.readFileSync(fake.argsLog, "utf8").trim().split("\n");
    const staging = args[1]!;
    expect(args).toEqual([
      "dir", staging, "--config", path.join(root, "work", "gitleaks.toml"), "--gitleaks-ignore-path", path.join(root, "work", "ignore-empty"),
      "--ignore-gitleaks-allow", "--max-archive-depth", "0", "--redact", "--report-format", "json", "--report-path", "-",
      "--exit-code", "99", "--no-banner", "--no-color", "--log-level", "error", "--timeout", "60",
    ]);
    expect(fs.readFileSync(path.join(root, "work", "gitleaks.toml"), "utf8")).toBe("[extend]\nuseDefault = true\n");
    expect(fs.readFileSync(path.join(root, "bin", "cwd.log"), "utf8").trim()).toBe(path.join(root, "work", "cwd-empty"));
    expect(fs.readFileSync(path.join(root, "bin", "env.log"), "utf8")).not.toMatch(/GITLEAKS_/);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("exit 99 blocks and names the blob; any other exit fails closed", async () => {
    const root = tmpdir();
    const fake = fakeGitleaks(path.join(root, "bin"));
    const g = new Gitleaks({ binary: fake.path, workDir: path.join(root, "work"), children: new Children(), expectSha256: fake.sha256 });
    const hit = await g.scan([{ sha: "b".repeat(40), content: Buffer.from("FAKE-SECRET-1") }, { sha: "c".repeat(40), content: Buffer.from("ok") }]);
    expect(hit).toEqual({ clean: false, blobs: ["b".repeat(40)], rules: ["generic-api-key"], hits: [{ blob: "b".repeat(40), rule: "generic-api-key", line: 1 }] });
    fs.writeFileSync(fake.failFlag, "");
    await expect(g.scan([{ sha: "d".repeat(40), content: Buffer.from("x") }])).rejects.toThrow(ScanError);
  });

  it("refuses a binary that isn't the pinned build, or the wrong version", async () => {
    const root = tmpdir();
    const fake = fakeGitleaks(path.join(root, "bin"));
    await expect(new Gitleaks({ binary: fake.path, workDir: path.join(root, "w"), children: new Children() }).verify()).rejects.toThrow(/pinned/);
    await expect(new Gitleaks({ binary: fake.path, workDir: path.join(root, "w"), children: new Children(), expectSha256: "0".repeat(64) }).verify()).rejects.toThrow(/pinned/);
    const older = nodeProgram(path.join(root, "bin", "gitleaks-older"), 'process.stdout.write("8.30.0\\n");');
    const sha = (await import("../src/fsutil")).sha256Hex(fs.readFileSync(older));
    await expect(new Gitleaks({ binary: older, workDir: path.join(root, "w"), children: new Children(), expectSha256: sha }).verify()).rejects.toThrow(/version/);
    expect(() => new Gitleaks({ binary: "gitleaks", workDir: path.join(root, "w"), children: new Children() })).toThrow(/absolute/);
  });
});

describe("git (SR-11)", () => {
  it("every command carries the overrides", () => {
    const a = overrideArgs("/h", "/a");
    expect(a).toEqual(expect.arrayContaining(["core.hooksPath=/h", "core.fsmonitor=false", "protocol.file.allow=never", "protocol.allow=never", "credential.helper="]));
  });

  it("AC-18: a .husky/pre-commit and a repo hooksPath never run on the engine's commits", async () => {
    const root = tmpdir();
    const repo = path.join(root, "repo");
    initRepo(repo, { "a.txt": "a" });
    const marker = path.join(root, "ran");
    fs.mkdirSync(path.join(repo, ".husky"));
    for (const h of ["pre-commit", "post-commit", "reference-transaction", "post-checkout"]) {
      fs.writeFileSync(path.join(repo, ".husky", h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(repo, ".git", "hooks", h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    // The traps are armed only after the fixture's own commit, which would otherwise fire them.
    fs.writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
    git(repo, "add", ".gitattributes");
    git(repo, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "attrs", "--no-verify");
    git(repo, "config", "core.hooksPath", ".husky");
    git(repo, "config", "core.fsmonitor", `touch ${marker}`);
    git(repo, "config", "filter.evil.clean", `touch ${marker}`);
    git(repo, "config", "filter.evil.smudge", `touch ${marker}`);
    expect(fs.existsSync(marker)).toBe(false);
    const fake = fakeGitleaks(path.join(root, "bin"));
    const children = new Children();
    const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "home"), children });
    const scanner = new Gitleaks({ binary: fake.path, workDir: path.join(root, "gl"), children, expectSha256: fake.sha256 });
    const state = new StateRepo(g, scanner, repo, new MemoryLogger(), path.join(root, "tmp"));
    await state.ensureWorktree();
    await state.commit([{ path: "inbox/decision/D-0001.md", content: "x" }], "D-0001: test");
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(repo, "show", "factory/state:inbox/decision/D-0001.md")).toBe("x");
  });

  it("commits with few git processes, scans before writing, and leaves no object for a refused secret", async () => {
    const root = tmpdir();
    const repo = path.join(root, "repo");
    initRepo(repo, { "a.txt": "a" });
    const fake = fakeGitleaks(path.join(root, "bin"));
    const children = new Children();
    const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "home"), children });
    const state = new StateRepo(g, new Gitleaks({ binary: fake.path, workDir: path.join(root, "gl"), children, expectSha256: fake.sha256 }), repo, new MemoryLogger(), path.join(root, "tmp"));
    await state.ensureWorktree();
    const content = "héllo\n";
    expect(blobId("sha1", Buffer.from(content))).toBe(execFileSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8" }).trim());
    const calls: string[] = [];
    const orig = g.run.bind(g);
    g.run = (cwd, args, o) => (calls.push(args[0]!), orig(cwd, args, o));
    await state.commit([{ path: "interviews/F-001/a.jsonl", content: "one\n" }], "F-001: one");
    // Write the blob, read-tree, index, tree, commit, ref, the checkout's index; the head comes from the reader (F-014).
    expect(calls).toEqual(["hash-object", "read-tree", "update-index", "write-tree", "commit-tree", "update-ref", "update-index"]);
    calls.length = 0;
    await state.commit([{ path: "interviews/F-001/a.jsonl", content: "one\ntwo\n" }, { path: "interviews/F-001/b.jsonl", content: "b\n" }], "F-001: two");
    // On top of its own last commit the temp index is reused and the head is held (A-1); two blobs still take one process.
    expect(calls).toEqual(["hash-object", "update-index", "write-tree", "commit-tree", "update-ref", "update-index"]);
    expect(git(repo, "show", "factory/state:interviews/F-001/a.jsonl")).toBe("one\ntwo");
    expect(git(repo, "show", "factory/state:interviews/F-001/b.jsonl")).toBe("b");
    expect(git(repo, "show", "factory/state~1:interviews/F-001/a.jsonl")).toBe("one");
    expect(git(path.join(repo, ".factory"), "status", "--porcelain")).toBe("");
    // A commit made elsewhere moves the branch: the held head fails the swap, and the commit is made again on the moved head, reading its tree and keeping its files (F-014 AC-5).
    const other = git(repo, "commit-tree", git(repo, "rev-parse", "factory/state^{tree}"), "-p", "factory/state", "-m", "elsewhere");
    git(repo, "update-ref", "refs/heads/factory/state", other);
    calls.length = 0;
    await state.commit([{ path: "interviews/F-001/c.jsonl", content: "c\n" }], "F-001: three");
    expect(calls).toContain("read-tree");
    expect(git(repo, "show", "factory/state~1")).toContain("elsewhere");
    expect(git(repo, "show", "factory/state:interviews/F-001/b.jsonl")).toBe("b");
    // A secret: refused before git ever stores it.
    const secret = "key FAKE-SECRET-77\n";
    await expect(state.commit([{ path: "interviews/F-001/d.jsonl", content: secret }], "F-001: secret")).rejects.toBeInstanceOf(SecretFound);
    const sha = blobId("sha1", Buffer.from(secret));
    expect(() => git(repo, "cat-file", "-e", sha)).toThrow();
  });

  it("refuses unsafe state paths", () => {
    for (const p of ["../x", "/x", "a/../b", ".git/config", "a/.GIT/x", "a\\b", "", "a//b"]) expect(() => checkStatePath(p)).toThrow();
    expect(() => checkStatePath("interviews/F-001/transcript.jsonl")).not.toThrow();
  });

  it("refuses an existing .factory that isn't the factory/state worktree", async () => {
    const root = tmpdir();
    const repo = path.join(root, "repo");
    initRepo(repo, { "a.txt": "a" });
    fs.mkdirSync(path.join(repo, ".factory"));
    const children = new Children();
    const fake = fakeGitleaks(path.join(root, "bin"));
    const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "home"), children });
    const state = new StateRepo(g, new Gitleaks({ binary: fake.path, workDir: path.join(root, "gl"), children, expectSha256: fake.sha256 }), repo, new MemoryLogger(), path.join(root, "tmp"));
    await expect(state.ensureWorktree()).rejects.toThrow(/not this repo's factory\/state worktree/);
  });
});

describe("transcript chain (SR-17, SR-22)", () => {
  const e1 = makeEntry(null, { type: "a", text: "x" }, "t1");
  const e2 = makeEntry(e1, { type: "b", text: "**md** <img src=x>" }, "t2");

  it("parses its own output and checks every link", () => {
    const text = serialize([e1, e2]);
    expect(text.split("\n")[1]).toContain('"text":"**md** <img src=x>"');
    expect(parseTranscript(text)).toEqual([e1, e2]);
    expect(() => parseTranscript(text.replace('"x"', '"y"'))).toThrow(ChainError);
    expect(() => parseTranscript(serialize([e2]))).toThrow(ChainError);
    expect(() => makeEntry(null, { type: "a", seq: 9 } as never, "t")).toThrow(ChainError);
    expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it("accepts only what the engine wrote: no extension, truncation or rewrite", () => {
    expect(() => checkAgainstHead([e1, e2], { seq: 2, head: e2.hash })).not.toThrow();
    expect(() => checkAgainstHead([e1, e2], { seq: 1, head: e1.hash })).toThrow(/didn't write/);
    expect(() => checkAgainstHead([e1], { seq: 2, head: e2.hash })).toThrow(/shorter/);
    expect(() => checkAgainstHead([e1, e2], null)).toThrow(/no record/);
    expect(() => checkAgainstHead([], null)).not.toThrow();
  });
});

describe("project paths file and manifest (SR-13, H-0080, H-0081)", () => {
  it("accepts only `projects: [{ path }]`, owned by the owner, not a link", () => {
    const root = tmpdir();
    const f = path.join(root, "factory-projects.local.yaml");
    // The real OS checks: mode and uid on Unix, owner and ACL (through the FFI module) on Windows.
    const host = process.platform === "win32" ? realOsApi() : linuxOs;
    fs.writeFileSync(f, "projects:\n  - path: /a\n", { mode: 0o600 });
    ownerOnly(f);
    expect(readPathsFile(root, host)).toEqual(["/a"]);
    for (const bad of ["projects:\n  - path: /a\n    owner: 1\n", "projects: []\nsettings: {}\n", "projects: x\n", "[", "a: &x 1\nb: *x\n"]) {
      fs.writeFileSync(f, bad);
      expect(() => readPathsFile(root, host)).toThrow(ConfigError);
    }
  });

  it.skipIf(!canSymlink())(needsSymlinks("refuses a project paths file that is a symbolic link"), () => {
    const root = tmpdir();
    const f = path.join(root, "factory-projects.local.yaml");
    const host = process.platform === "win32" ? realOsApi() : linuxOs;
    fs.writeFileSync(path.join(root, "real.yaml"), "projects: []\n", { mode: 0o600 });
    ownerOnly(path.join(root, "real.yaml"));
    fs.symlinkSync(path.join(root, "real.yaml"), f);
    expect(() => readPathsFile(root, host)).toThrow(/symbolic link/);
  });

  it("on Windows, checks the owner and ACL through the FFI module", () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, "factory-projects.local.yaml"), "projects: []\n");
    const me = "S-1-5-21-1-2-3-1001";
    const win = (sddl: string): OsApi => ({ ...linuxOs, platform: "win32", windows: () => ({ currentUserSid: () => me, fileSddl: () => sddl }) as unknown as WindowsApi });
    expect(readPathsFile(root, win(`O:${me}D:(A;;FA;;;${me})`))).toEqual([]);
    expect(() => readPathsFile(root, win(`O:${me}D:(A;;FA;;;${me})(A;;FW;;;BU)`))).toThrow(/writable by nobody else/);
  });

  it("validates the H-0080 keys exactly", () => {
    const ok = YAML.parse(manifestYaml());
    expect(validateManifest(ok, "c").owner).toEqual({ github_id: OWNER_ID, oauth_client_id: CLIENT_ID });
    const variants: Array<[string, (m: Record<string, any>) => void]> = [
      ["enabled", (m) => delete m.enabled],
      ["enabled", (m) => (m.enabled = "yes")],
      ["owner", (m) => delete m.owner],
      ["owner", (m) => (m.owner.extra = 1)],
      ["github_id", (m) => (m.owner.github_id = "1")],
      ["github_id", (m) => (m.owner.github_id = -4)],
      ["oauth_client_id", (m) => (m.owner.oauth_client_id = "")],
      ["allowed_repo_owners", (m) => (m.allowed_repo_owners = [{ login: "x" }])],
      ["url", (m) => (m.repos[0].url = "https://gitlab.com/a/b")],
      ["budget", (m) => delete m.settings],
      ["schema", (m) => (m.schema = "factory-project/2.0")],
    ];
    for (const [word, change] of variants) {
      const m = structuredClone(ok);
      change(m);
      expect(() => validateManifest(m, "c")).toThrow(word);
    }
  });

  it("pins compare owner.*, allowed_repo_owners and enabled", () => {
    const m = validateManifest(YAML.parse(manifestYaml()), "c");
    const pin = { ...pinnedKeys(m), pinned_at: "t", commit: "c" };
    expect(comparePin(pin, m)).toEqual({ status: "match" });
    expect(comparePin(null, m)).toEqual({ status: "new_path" });
    expect(comparePin(pin, { ...m, enabled: false, owner: { ...m.owner, oauth_client_id: "other" } })).toEqual({ status: "changed", keys: ["owner", "enabled"] });
    expect(comparePin(pin, { ...m, allowed_repo_owners: [] })).toEqual({ status: "changed", keys: ["allowed_repo_owners"] });
  });

  it("pins the interview sign-in setting; a pin made before it matches a manifest without one (F-018 FR-15)", () => {
    const m = validateManifest(YAML.parse(manifestYaml()), "c");
    const { interview_sign_in: _, ...old } = { ...pinnedKeys(m), pinned_at: "t", commit: "c" };
    expect(comparePin(old, m)).toEqual({ status: "match" });
    const hourly = validateManifest(YAML.parse(manifestYaml({ extra: "  interview_sign_in: { every: hours, hours: 8 }" })), "c");
    expect(comparePin(old, hourly)).toEqual({ status: "changed", keys: ["settings.interview_sign_in"] });
    expect(comparePin({ ...pinnedKeys(hourly), pinned_at: "t", commit: "c" }, hourly)).toEqual({ status: "match" });
  });

  it("reads settings.interview_sign_in, defaults it by level, and allows never only at Rapid prototype (F-018 FR-15)", () => {
    const read = (extra: string, level = "alpha") => validateManifest(YAML.parse(manifestYaml({ extra }).replace("maturity: prototype", `maturity: ${level}`)), "c");
    expect(interviewSignIn(read(""))).toEqual({ every: "session" });
    expect(interviewSignIn(read("", "rapid-prototype"))).toEqual({ every: "never" });
    expect(read("  interview_sign_in: { every: engine_start }").interviewSignIn).toEqual({ every: "engine_start" });
    expect(read("  interview_sign_in: { every: hours, hours: 168 }").interviewSignIn).toEqual({ every: "hours", hours: 168 });
    expect(read("  interview_sign_in: { every: never }", "rapid-prototype").interviewSignIn).toEqual({ every: "never" });
    for (const [extra, word] of [
      ["  interview_sign_in: { every: never }", /only at rapid-prototype/],
      ["  interview_sign_in: { every: daily }", /must be one of/],
      ["  interview_sign_in: { every: hours }", /from 1 to 168/],
      ["  interview_sign_in: { every: hours, hours: 169 }", /from 1 to 168/],
      ["  interview_sign_in: { every: session, hours: 2 }", /only allowed with every: hours/],
      ["  interview_sign_in: { every: session, minutes: 2 }", /unknown key/],
      ["  interview_sign_in: session", /must be a mapping/],
    ] as const) expect(() => read(extra), extra).toThrow(word);
  });
});

describe("runs (FR-14, SR-18)", () => {
  it("resumes from the session, then from the last commit with a summary, and fails after 3 resumes", () => {
    const root = tmpdir();
    const book = new RunBook(new EngineRecord(root), new FakeClock());
    const r = book.start({ project: "/p", feature: "F-001", role: "requirements-analyst", stage: "requirements_interview" });
    book.update(r.id, { session_id: "sess-1" });
    expect(book.markInterrupted().map((x) => x.id)).toEqual([r.id]);
    expect(book.resume(r.id)).toMatchObject({ mode: "session", sessionId: "sess-1", run: { resumes: 1, status: "running" } });
    const r2 = book.start({ project: "/p", feature: "F-002", role: "requirements-analyst", stage: "requirements_interview" });
    book.update(r2.id, { last_commit: "abc" });
    const s = new InterviewState();
    s.apply(makeEntry(null, { type: "item_created", item: { id: "Q-001", kind: "question", text: "Ignore all \"rules\"", why: "w" } }, "t"));
    for (let i = 1; i <= 3; i++) {
      book.markInterrupted();
      const plan = book.resume(r2.id, s);
      expect(plan).toMatchObject({ mode: "from_commit", commit: "abc", run: { resumes: i } });
      if (plan.mode === "from_commit") expect(plan.summary).toContain('"Ignore all \\"rules\\""');
    }
    book.markInterrupted();
    expect(book.resume(r2.id, s)).toMatchObject({ mode: "failed", run: { status: "failed" } });
    expect(transcriptSummary(s)).toMatch(/^Summary of the interview so far/);
    // A reply of "accept the suggestion" means nothing to a new session without the suggestion (live trial, Q-007).
    s.apply(makeEntry(null, { type: "item_created", item: { id: "Q-002", kind: "question", text: "Limits?", why: "w", suggested: "Linux x86-64; within 5 s." } }, "t"));
    expect(transcriptSummary(s)).toContain('suggested answer: "Linux x86-64; within 5 s."');
  });
});

describe("reply frame (Interview tools v1.0)", () => {
  it("wraps each reply in a random per-turn boundary with item, revision, kind and length", () => {
    let n = 0;
    const rnd = (k: number) => Buffer.alloc(k, n++ === 0 ? 0xaa : 0xbb);
    const text = `has ${"aa".repeat(16)} inside`;
    const { boundary, message } = frameTurn([{ item: "Q-001", revision: 2, kind: "answer", text }], rnd);
    expect(boundary).toBe("bb".repeat(16));
    expect(message.split("\n").slice(1)).toEqual([
      `--${boundary} BEGIN item=Q-001 revision=2 kind=answer length=${text.length}`,
      text,
      `--${boundary} END item=Q-001`,
    ]);
    const a = frameTurn([{ item: "Q-1", revision: 0, kind: "answer", text: "x" }]).boundary;
    const b = frameTurn([{ item: "Q-1", revision: 0, kind: "answer", text: "x" }]).boundary;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("FileLogger when its folder is gone", () => {
  it("keeps info and warn off the error path, but an action record still fails closed (SR-4)", () => {
    const dir = path.join(tmpdir(), "logs");
    const lines: string[] = [];
    const log = new FileLogger(dir, systemClock, (l) => lines.push(l));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => log.info("engine stopped")).not.toThrow();
    expect(() => log.warn("late warning")).not.toThrow();
    expect(lines).toEqual(["factory-engine: engine stopped", "factory-engine: late warning"]);
    expect(() => log.action({ kind: "push", target: "x", outcome: "ok" } as never)).toThrow(/ENOENT/);
  });
});

describe("engine.status activity codes (F-018 FR-14, H-0225)", () => {
  it("maps stage, pause, a running job and item states to the fixed codes", async () => {
    const { activityOf } = await import("../src/interview/activity");
    const a = (stage: string, running: boolean, statuses: Array<"open" | "researching" | "answered">, paused = false) => activityOf({ stage, paused, running, statuses });
    expect(a("requirements_interview", true, ["open"], true)).toBe("paused");
    expect(a("requirements_interview", true, ["answered", "open"])).toBe("analyst_reviewing");
    expect(a("requirements_interview", true, ["researching"])).toBe("analyst_researching");
    expect(a("requirements_interview", true, ["answered"])).toBe("analyst_writing_spec");
    expect(a("security_gate_1", true, [])).toBe("security_reviewing");
    expect(a("readiness_gate", true, [])).toBe("readiness_check");
    expect(a("requirements_interview", false, ["open"])).toBe("waiting_for_owner");
    expect(a("build_and_test_prep", false, [])).toBe("idle");
  });
});
