import { GitHubError, GitHubUnreachable, checkBase } from "../github";
import type { Logger } from "../log";

export interface Issue {
  number: number;
  state: "open" | "closed";
  body: string;
  author: string;
  labels: string[];
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  authorId: number;
  authorType: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface Reaction {
  id: number;
  content: string;
  userId: number;
  createdAt: string;
}

/**
 * Every GitHub call the inbox makes (F-011 SR-1), with the owner's factory
 * token. There is no merge call and no create-reaction call here: the engine
 * only reads reactions (F-011 FR-14), checked by test/inbox-calls.test.ts.
 */
export interface IssuesApi {
  repoPrivacy(repo: string): Promise<{ private: boolean; collaboratorIds: number[] }>;
  dispatch(repo: string, payload: Record<string, unknown>): Promise<void>;
  openIssues(repo: string): Promise<Issue[]>;
  issue(repo: string, n: number): Promise<Issue | null>;
  comments(repo: string, n: number): Promise<IssueComment[]>;
  reactions(repo: string, commentId: number): Promise<Reaction[]>;
  comment(repo: string, n: number, body: string): Promise<number>;
  editComment(repo: string, commentId: number, body: string): Promise<void>;
  updateIssue(repo: string, n: number, patch: { body?: string; labels?: string[]; state?: "open" | "closed" }): Promise<void>;
}

/** The workflow that opens issues and posts action comments signs as this account (F-011 FR-4). */
export const WORKFLOW_LOGIN = "github-actions[bot]";
export const DISPATCH_TYPE = "factory-inbox";

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;

function checkRepo(repo: string): string {
  if (!REPO_RE.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) throw new GitHubError("malformed repository name");
  return repo;
}

const isPosInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** GitHub's answers are input (S1.1, S4.5): every field the inbox uses is checked for type here. */
function toIssue(b: Record<string, unknown>): Issue {
  if (!isPosInt(b.number) || (b.state !== "open" && b.state !== "closed")) throw new GitHubError("GitHub sent a malformed issue");
  const labels = Array.isArray(b.labels) ? b.labels.map((l) => str((l as Record<string, unknown>)?.name)).filter(Boolean) : [];
  return { number: b.number, state: b.state, body: str(b.body), author: str((b.user as Record<string, unknown> | null)?.login), labels };
}

function toComment(b: Record<string, unknown>): IssueComment {
  const u = (b.user ?? {}) as Record<string, unknown>;
  if (!isPosInt(b.id) || !isPosInt(u.id)) throw new GitHubError("GitHub sent a malformed comment");
  return {
    id: b.id, body: str(b.body), author: str(u.login), authorId: u.id, authorType: str(u.type),
    createdAt: str(b.created_at), updatedAt: str(b.updated_at), url: str(b.html_url),
  };
}

function toReaction(b: Record<string, unknown>): Reaction {
  const u = (b.user ?? {}) as Record<string, unknown>;
  if (!isPosInt(b.id) || !isPosInt(u.id)) throw new GitHubError("GitHub sent a malformed reaction");
  return { id: b.id, content: str(b.content), userId: u.id, createdAt: str(b.created_at) };
}

export class HttpIssues implements IssuesApi {
  private readonly api: string;

  constructor(private readonly token: string, private readonly log: Logger, apiBase: string) {
    this.api = checkBase(apiBase);
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; next: string | null }> {
    let res: Response;
    try {
      res = await fetch(path.startsWith(this.api) ? path : `${this.api}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new GitHubUnreachable((e as Error)?.name ?? "network error");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE) throw new GitHubError("GitHub's answer is too large");
    let parsed: unknown = null;
    try {
      parsed = buf.length ? JSON.parse(buf.toString("utf8")) : null;
    } catch {
      parsed = null;
    }
    // Only a next page on the same API host is followed.
    const link = res.headers.get("link") ?? "";
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    const next = m && m[1]!.startsWith(this.api + "/") ? m[1]! : null;
    if (res.status === 429 || res.status >= 500 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      throw new GitHubUnreachable(`HTTP ${res.status}`);
    }
    return { status: res.status, body: parsed, next };
  }

  private async list(path: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let url: string | null = path;
    for (let i = 0; url && i < MAX_PAGES; i++) {
      const r = await this.call("GET", url);
      if (r.status !== 200 || !Array.isArray(r.body)) throw new GitHubError(`GitHub refused a list (HTTP ${r.status})`);
      out.push(...(r.body as Array<Record<string, unknown>>));
      url = r.next;
    }
    return out;
  }

  private act(action: string, target: string, status: number): void {
    this.log.action({ agent: "engine", action, target, outcome: String(status) });
  }

  async repoPrivacy(repo: string): Promise<{ private: boolean; collaboratorIds: number[] }> {
    const r = await this.call("GET", `/repos/${checkRepo(repo)}`);
    if (r.status !== 200 || typeof (r.body as Record<string, unknown>)?.private !== "boolean") throw new GitHubError(`the config repo isn't readable (HTTP ${r.status})`);
    const people = await this.list(`/repos/${repo}/collaborators?affiliation=all&per_page=100`);
    return {
      private: (r.body as { private: boolean }).private,
      collaboratorIds: people.map((p) => p.id).filter(isPosInt),
    };
  }

  async dispatch(repo: string, payload: Record<string, unknown>): Promise<void> {
    const r = await this.call("POST", `/repos/${checkRepo(repo)}/dispatches`, { event_type: DISPATCH_TYPE, client_payload: payload });
    this.act("github.repository_dispatch", repo, r.status);
    if (r.status !== 204) throw new GitHubError(`GitHub refused the inbox dispatch (HTTP ${r.status})`);
  }

  async openIssues(repo: string): Promise<Issue[]> {
    const all = await this.list(`/repos/${checkRepo(repo)}/issues?state=open&labels=factory-inbox&creator=${encodeURIComponent(WORKFLOW_LOGIN)}&per_page=100`);
    return all.filter((b) => !b.pull_request).map(toIssue);
  }

  async issue(repo: string, n: number): Promise<Issue | null> {
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/issues/${n}`);
    if (r.status === 404 || r.status === 410) return null;
    if (r.status !== 200) throw new GitHubError(`GitHub refused issue ${n} (HTTP ${r.status})`);
    return toIssue(r.body as Record<string, unknown>);
  }

  async comments(repo: string, n: number): Promise<IssueComment[]> {
    return (await this.list(`/repos/${checkRepo(repo)}/issues/${n}/comments?per_page=100`)).map(toComment);
  }

  async reactions(repo: string, commentId: number): Promise<Reaction[]> {
    return (await this.list(`/repos/${checkRepo(repo)}/issues/comments/${commentId}/reactions?per_page=100`)).map(toReaction);
  }

  async comment(repo: string, n: number, body: string): Promise<number> {
    const r = await this.call("POST", `/repos/${checkRepo(repo)}/issues/${n}/comments`, { body });
    this.act("github.create_comment", `${repo}#${n}`, r.status);
    const id = (r.body as Record<string, unknown> | null)?.id;
    if (r.status !== 201 || !isPosInt(id)) throw new GitHubError(`GitHub refused a comment (HTTP ${r.status})`);
    return id;
  }

  async editComment(repo: string, commentId: number, body: string): Promise<void> {
    const r = await this.call("PATCH", `/repos/${checkRepo(repo)}/issues/comments/${commentId}`, { body });
    this.act("github.update_comment", `${repo} comment ${commentId}`, r.status);
    if (r.status !== 200) throw new GitHubError(`GitHub refused a comment edit (HTTP ${r.status})`);
  }

  async updateIssue(repo: string, n: number, patch: { body?: string; labels?: string[]; state?: "open" | "closed" }): Promise<void> {
    const r = await this.call("PATCH", `/repos/${checkRepo(repo)}/issues/${n}`, patch);
    this.act(`github.update_issue:${Object.keys(patch).join(",")}`, `${repo}#${n}`, r.status);
    if (r.status !== 200) throw new GitHubError(`GitHub refused an issue update (HTTP ${r.status})`);
  }
}
