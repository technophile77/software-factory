import { Clock, iso } from "./clock";
import {
  DEVICE_GRANT_TYPE, DEVICE_VERIFICATION_URI, GITHUB_API_BASE, GITHUB_WEB_BASE, MAX_DEVICE_EXPIRES_S, USER_CODE_RE,
} from "./constants";
import { Logger } from "./log";

export class GitHubError extends Error {
  override name = "GitHubError";
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type PollResult =
  | { kind: "token"; token: string }
  | { kind: "pending" }
  | { kind: "slow_down"; interval: number | null }
  | { kind: "denied" | "expired" };

export interface RepoInfo {
  status: number;
  ownerId?: number;
  private?: boolean;
}

/** What the engine asks of GitHub. Injectable so tests can use a fake GitHub. */
export interface GitHubClient {
  requestDeviceCode(clientId: string): Promise<DeviceCode>;
  pollToken(clientId: string, deviceCode: string): Promise<PollResult>;
  userId(token: string): Promise<number>;
  repo(owner: string, name: string, token: string): Promise<RepoInfo>;
  /** GitHub's web and git base. Absent means https://github.com. */
  readonly webBase?: string;
}

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 15_000;
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{16,256}$/;
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,512}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function checkBase(base: string): string {
  const u = new URL(base);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  // Plain http only for a fake GitHub on this machine; real GitHub is https with Node's default TLS checks.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new GitHubError("GitHub base URLs must be https");
  return base.replace(/\/+$/, "");
}

const isPosInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;

/** Validates GitHub's device code answer field by field (SR-23). */
export function parseDeviceCode(body: unknown): DeviceCode {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.device_code !== "string" || !DEVICE_CODE_RE.test(b.device_code)) throw new GitHubError("GitHub sent a malformed device_code");
  if (typeof b.user_code !== "string" || !USER_CODE_RE.test(b.user_code)) throw new GitHubError("GitHub sent a malformed user_code");
  if (b.verification_uri !== DEVICE_VERIFICATION_URI) throw new GitHubError("GitHub sent an unexpected verification_uri");
  if (!isPosInt(b.expires_in, MAX_DEVICE_EXPIRES_S)) throw new GitHubError("GitHub sent an expires_in over 900 s");
  if (!isPosInt(b.interval, MAX_DEVICE_EXPIRES_S)) throw new GitHubError("GitHub sent a malformed interval");
  return { deviceCode: b.device_code, userCode: b.user_code, verificationUri: b.verification_uri, expiresIn: b.expires_in, interval: b.interval };
}

export function parsePoll(body: unknown): PollResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.access_token === "string") {
    if (!TOKEN_RE.test(b.access_token) || (typeof b.token_type === "string" && b.token_type.toLowerCase() !== "bearer")) {
      throw new GitHubError("GitHub sent a malformed token");
    }
    return { kind: "token", token: b.access_token };
  }
  switch (b.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down", interval: isPosInt(b.interval, MAX_DEVICE_EXPIRES_S) ? b.interval : null };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default:
      throw new GitHubError("GitHub refused the device sign-in");
  }
}

export class HttpGitHub implements GitHubClient {
  private readonly web: string;
  /** Where GitHub's web and git endpoints are; pushes and fetches go nowhere else. */
  get webBase(): string {
    return this.web;
  }
  private readonly api: string;
  private readonly log: Logger;

  constructor(o: { webBase?: string; apiBase?: string; log: Logger }) {
    this.log = o.log;
    this.web = checkBase(o.webBase ?? GITHUB_WEB_BASE);
    this.api = checkBase(o.apiBase ?? GITHUB_API_BASE);
  }

  private async call(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new GitHubError("GitHub is unreachable");
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) {
          await reader.cancel();
          throw new GitHubError("GitHub's answer is too large");
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async requestDeviceCode(clientId: string): Promise<DeviceCode> {
    if (!CLIENT_ID_RE.test(clientId)) throw new GitHubError("malformed OAuth client id");
    // No scope: the token only proves who approved (ADR 0014).
    const r = await this.call(`${this.web}/login/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId }).toString(),
    });
    this.log.action({ agent: "engine", action: "github.device_code", target: `${this.web}/login/device/code`, outcome: String(r.status) });
    if (r.status !== 200) throw new GitHubError("GitHub refused the device code request");
    return parseDeviceCode(r.body);
  }

  async pollToken(clientId: string, deviceCode: string): Promise<PollResult> {
    const r = await this.call(`${this.web}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT_TYPE }).toString(),
    });
    if (r.status !== 200) throw new GitHubError("GitHub refused the token request");
    return parsePoll(r.body);
  }

  async userId(token: string): Promise<number> {
    const r = await this.call(`${this.api}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    this.log.action({ agent: "engine", action: "github.get_user", target: `${this.api}/user`, outcome: String(r.status) });
    const id = (r.body as Record<string, unknown> | null)?.id;
    if (r.status !== 200 || !isPosInt(id)) throw new GitHubError("GitHub didn't confirm the account");
    return id;
  }

  async repo(owner: string, name: string, token: string): Promise<RepoInfo> {
    const r = await this.call(`${this.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    this.log.action({ agent: "engine", action: "github.get_repo", target: `${owner}/${name}`, outcome: String(r.status) });
    if (r.status !== 200) return { status: r.status };
    const b = r.body as Record<string, unknown> | null;
    const ownerId = (b?.owner as Record<string, unknown> | undefined)?.id;
    if (!isPosInt(ownerId) || typeof b?.private !== "boolean") throw new GitHubError("GitHub sent a malformed repository");
    return { status: 200, ownerId, private: b.private };
  }
}

export type ApprovalOutcome = { approved: true } | { approved: false; reason: string };

export interface PendingApproval {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  /** Settles once: approved only for the expected numeric GitHub id. */
  result: Promise<ApprovalOutcome>;
}

/**
 * ADR 0014's device approval: request a code, poll at GitHub's interval
 * (slowing down when told), and accept only when the token's account id
 * equals `ownerId`. The token is used for that one call and dropped. Any
 * other outcome, including GitHub being unreachable, fails closed.
 */
export async function startDeviceApproval(o: {
  github: GitHubClient;
  clientId: string;
  ownerId: number;
  clock: Clock;
  signal: AbortSignal;
  log: Logger;
  approvalId: string;
}): Promise<PendingApproval> {
  const code = await o.github.requestDeviceCode(o.clientId);
  const start = o.clock.now();
  const deadline = start + code.expiresIn * 1000;
  const result = (async (): Promise<ApprovalOutcome> => {
    let interval = code.interval;
    for (;;) {
      await o.clock.sleep(interval * 1000, o.signal);
      if (o.signal.aborted) return { approved: false, reason: "closed" };
      if (o.clock.now() >= deadline) return { approved: false, reason: "expired" };
      let poll: PollResult;
      try {
        poll = await o.github.pollToken(o.clientId, code.deviceCode);
      } catch (e) {
        return { approved: false, reason: e instanceof GitHubError ? e.message : "GitHub is unreachable" };
      }
      if (poll.kind === "pending") continue;
      if (poll.kind === "slow_down") {
        interval = Math.max(poll.interval ?? 0, interval + 5);
        continue;
      }
      if (poll.kind !== "token") return { approved: false, reason: poll.kind };
      let id: number;
      try {
        id = await o.github.userId(poll.token);
      } catch {
        return { approved: false, reason: "GitHub didn't confirm the account" };
      }
      // The token goes out of scope here; nothing keeps or logs it.
      const ok = id === o.ownerId;
      o.log.action({ agent: "engine", action: "device_approval", target: "owner", approval_id: o.approvalId, outcome: ok ? "approved" : "wrong_account" });
      return ok ? { approved: true } : { approved: false, reason: "wrong account" };
    }
  })();
  return { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: iso(deadline), result };
}
