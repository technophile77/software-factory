import * as crypto from "node:crypto";
import { Clock, iso } from "../clock";
import { MAX_APPROVAL_WAIT_S, RPC, SESSION_IDLE_MS, SESSION_MAX_MS, SESSION_RE } from "../constants";
import { GitHubClient, startDeviceApproval } from "../github";
import { Logger } from "../log";
import type { InterviewSignIn } from "../config/manifest";
import { RpcError } from "./framing";

type State = "pending" | "approved" | "failed" | "ended";

export interface Session {
  no: number;
  feature: string;
  startedAt: number;
  lastCall: number;
  state: State;
  approvedAt?: number;
  /** Absent when the session opened without sign-in (F-018 FR-13, FR-15). */
  approval?: { user_code: string; verification_uri: string; expires_at: string };
  abort: AbortController;
  result: Promise<boolean>;
  /** Deferred items already returned in this session. */
  shown: Set<string>;
}

export interface Owner {
  githubId: number;
  oauthClientId: string;
}

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * Interview sessions of one project (channel v1.1/v1.2, ADR 0014, SR-16).
 * The lock is the session token, not a connection. Tokens are kept only as
 * hashes, and nothing here writes them anywhere. A session takes replies
 * only after the project's pinned owner approves it on GitHub, as often as
 * the project's sign-in setting asks (F-018 FR-15): never, once per engine
 * start, every session, or once per so many hours. Sessions opened without
 * a sign-in are the risk recorded in F-018 SR-8.
 */
export class SessionManager {
  private readonly byToken = new Map<string, Session>();
  private readonly locks = new Map<string, string>();
  private counter = 0;
  /** When the owner last signed in during this engine run. */
  private lastSignIn: number | undefined;

  constructor(
    private readonly project: string,
    private readonly owner: Owner,
    private readonly github: GitHubClient,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly onApproved: (feature: string, session: number, signIn: boolean) => Promise<void> = async () => undefined,
    private readonly signIn: InterviewSignIn = { every: "session" },
  ) {}

  /** Whether a new session needs the owner's sign-in under the project's setting. */
  private needsSignIn(): boolean {
    const last = this.lastSignIn;
    switch (this.signIn.every) {
      case "never":
        return false;
      case "engine_start":
        return last === undefined;
      case "hours":
        return last === undefined || this.clock.now() - last >= (this.signIn.hours ?? 0) * 3_600_000;
      default:
        return true;
    }
  }

  private live(s: Session): boolean {
    const now = this.clock.now();
    if (s.state === "failed" || s.state === "ended") return false;
    if (now - s.lastCall >= SESSION_IDLE_MS) return false;
    if (s.state === "approved" && s.approvedAt !== undefined && now - s.approvedAt >= SESSION_MAX_MS) return false;
    return true;
  }

  private end(tokenHash: string, s: Session, state: State): void {
    if (s.state === "pending" || s.state === "approved") s.state = state;
    s.abort.abort();
    if (this.locks.get(s.feature) === tokenHash) this.locks.delete(s.feature);
  }

  async open(feature: string, takeover: boolean): Promise<{ session: string; started_at: string; approval?: Session["approval"] }> {
    const held = this.locks.get(feature);
    if (held) {
      const s = this.byToken.get(held)!;
      if (this.live(s) && !takeover) {
        throw new RpcError(RPC.busy, "Another session holds this feature.", { started_at: iso(s.startedAt) });
      }
      // A takeover is a new session and needs its own approval (ADR 0014).
      this.end(held, s, "ended");
    }
    const abort = new AbortController();
    const no = ++this.counter;
    if (!this.needsSignIn()) return this.withoutSignIn(feature, no, abort);
    let pending;
    try {
      pending = await startDeviceApproval({
        github: this.github, clientId: this.owner.oauthClientId, ownerId: this.owner.githubId,
        clock: this.clock, signal: abort.signal, log: this.log, approvalId: `${this.project}#${no}`,
      });
    } catch {
      this.log.warn(`${this.project}: GitHub device sign-in couldn't start for ${feature}; no session opened.`);
      throw new RpcError(RPC.approvalFailed, "GitHub sign-in couldn't start, so no session was opened.");
    }
    const token = crypto.randomBytes(16).toString("hex");
    const th = hash(token);
    const now = this.clock.now();
    const s: Session = {
      no, feature, startedAt: now, lastCall: now, state: "pending", abort, shown: new Set(),
      approval: { user_code: pending.userCode, verification_uri: pending.verificationUri, expires_at: pending.expiresAt },
      result: pending.result.then(async (r) => {
        if (s.state !== "pending") return s.state === "approved";
        if (r.approved) {
          // The approval is on the record before the session takes a reply.
          await this.onApproved(feature, no, true).catch(() => undefined);
          if (s.state !== "pending") return false;
          s.state = "approved";
          s.approvedAt = this.clock.now();
          this.lastSignIn = s.approvedAt;
          // A session approved after it went idle starts its idle clock at approval.
          s.lastCall = s.approvedAt;
          return true;
        }
        this.log.warn(`${this.project}: session ${no} for ${feature} was not approved (${r.reason}).`);
        this.end(th, s, "failed");
        return false;
      }),
    };
    this.byToken.set(th, s);
    this.locks.set(feature, th);
    return { session: token, started_at: iso(now), approval: s.approval };
  }

  /** A session opened with no device sign-in, so `open` returns no `approval`. */
  private async withoutSignIn(feature: string, no: number, abort: AbortController): Promise<{ session: string; started_at: string }> {
    // On the record before the session takes a reply, as a device approval is.
    await this.onApproved(feature, no, false).catch(() => undefined);
    const token = crypto.randomBytes(16).toString("hex");
    const th = hash(token);
    const now = this.clock.now();
    const s: Session = {
      no, feature, startedAt: now, lastCall: now, state: "approved", approvedAt: now, abort, shown: new Set(),
      result: Promise.resolve(true),
    };
    this.byToken.set(th, s);
    this.locks.set(feature, th);
    this.log.info(`${this.project}: session ${no} for ${feature} opened without sign-in (setting: ${this.signIn.every}).`);
    return { session: token, started_at: iso(now) };
  }

  /** The session for `token`, counted as a call. Errors follow channel v1.1/v1.2. */
  get(token: unknown): Session {
    if (typeof token !== "string" || !SESSION_RE.test(token)) throw new RpcError(RPC.session, "Unknown or expired session.");
    const th = hash(token);
    const s = this.byToken.get(th);
    if (!s) throw new RpcError(RPC.session, "Unknown or expired session.");
    if (s.state === "failed") throw new RpcError(RPC.approvalFailed, "The session's GitHub approval failed.");
    if (!this.live(s)) {
      this.end(th, s, "ended");
      throw new RpcError(RPC.session, "Unknown or expired session.");
    }
    s.lastCall = this.clock.now();
    return s;
  }

  approved(token: unknown): Session {
    const s = this.get(token);
    if (s.state === "pending") throw new RpcError(RPC.approvalPending, "The session is waiting for the owner's GitHub approval.");
    return s;
  }

  async awaitApproval(token: unknown, waitS: number): Promise<{ approved: true }> {
    const s = this.get(token);
    if (s.state === "approved") return { approved: true };
    const wait = Math.min(Math.max(0, waitS), MAX_APPROVAL_WAIT_S) * 1000;
    const timer = new AbortController();
    const ok = await Promise.race([s.result, this.clock.sleep(wait, timer.signal).then(() => null)]);
    timer.abort();
    if (ok === true) return { approved: true };
    // Refresh the state the waiting may have changed, then report it.
    if (s.state === "failed") throw new RpcError(RPC.approvalFailed, "The session's GitHub approval failed.");
    this.get(token);
    throw new RpcError(RPC.approvalPending, "The session is waiting for the owner's GitHub approval.");
  }

  close(token: unknown): void {
    const s = this.get(token);
    this.end(hash(token as string), s, "ended");
  }

  /** Ends every session (shutdown, project stopped). */
  closeAll(): void {
    for (const [th, s] of this.byToken) this.end(th, s, "ended");
  }
}
