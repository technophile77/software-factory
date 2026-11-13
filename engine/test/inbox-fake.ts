import type { Issue, IssueComment, IssuesApi, Reaction } from "../src/inbox/github-issues";

export const OWNER = 1000001;
export const OTHER = 2000002;

/**
 * GitHub's issues as the inbox sees them, with the config repo's workflow
 * built in: a dispatch opens the issue and posts the action comments as
 * github-actions[bot], as templates/config-repo/.github/workflows/factory-inbox.yml does.
 */
export class FakeIssues implements IssuesApi {
  private: boolean = true;
  collaborators: number[] = [OWNER];
  /** Set to make the workflow do nothing, as when Actions is down. */
  workflowDown = false;
  issues = new Map<number, Issue & { title: string; assignees: string[] }>();
  comments_ = new Map<number, Array<IssueComment & { issue: number }>>();
  reactions_ = new Map<number, Reaction[]>();
  dispatches: Array<Record<string, unknown>> = [];
  calls: string[] = [];
  private next = 1;
  private nextComment = 1000;
  private nextReaction = 50;
  now = () => "2026-11-11T10:00:00Z";

  async repoPrivacy() {
    this.calls.push("privacy");
    return { private: this.private, collaboratorIds: this.collaborators };
  }

  async dispatch(_repo: string, p: Record<string, unknown>) {
    this.calls.push("dispatch");
    this.dispatches.push(p);
    if (this.workflowDown) return;
    let n = p.issue as number | undefined;
    if (n === undefined) {
      n = this.next++;
      this.issues.set(n, { number: n, state: "open", body: p.body as string, author: "github-actions[bot]", labels: p.labels as string[], title: p.title as string, assignees: ["owner"] });
    }
    for (const c of p.comments as string[]) this.add(n, c, { login: "github-actions[bot]", id: 41898282, type: "Bot" });
  }

  add(issue: number, body: string, who: { login: string; id: number; type: string }, edited = false): IssueComment {
    const id = this.nextComment++;
    const c = { id, body, author: who.login, authorId: who.id, authorType: who.type, createdAt: this.now(), updatedAt: edited ? "2026-11-11T11:00:00Z" : this.now(), url: `https://github.com/o/cfg/issues/${issue}#issuecomment-${id}`, issue };
    const list = this.comments_.get(issue) ?? [];
    list.push(c);
    this.comments_.set(issue, list);
    return c;
  }

  /** The owner (or someone else) comments. */
  say(issue: number, body: string, who = OWNER, edited = false): IssueComment {
    return this.add(issue, body, { login: who === OWNER ? "owner" : "other", id: who, type: "User" }, edited);
  }

  react(commentId: number, content: string, who = OWNER, at = this.now()): number {
    const id = this.nextReaction++;
    const list = this.reactions_.get(commentId) ?? [];
    list.push({ id, content, userId: who, createdAt: at });
    this.reactions_.set(commentId, list);
    return id;
  }

  actionComment(issue: number, action: string): IssueComment {
    return this.comments_.get(issue)!.filter((c) => c.author === "github-actions[bot]" && c.body.includes(` ${action} -->`)).pop()!;
  }

  replies(issue: number): string[] {
    return (this.comments_.get(issue) ?? []).filter((c) => c.authorId === OWNER && /^(Recorded|Not recorded|Confirm|Stale|Reopened):/.test(c.body)).map((c) => c.body);
  }

  async openIssues() {
    this.calls.push("openIssues");
    return [...this.issues.values()].filter((i) => i.state === "open");
  }

  async issue(_repo: string, n: number) {
    return this.issues.get(n) ?? null;
  }

  async comments(_repo: string, n: number) {
    return (this.comments_.get(n) ?? []).map(({ issue: _i, ...c }) => c);
  }

  async reactions(_repo: string, id: number) {
    return this.reactions_.get(id) ?? [];
  }

  /** The engine posts with the owner's token, so its comments carry the owner's id. */
  async comment(_repo: string, n: number, body: string) {
    this.calls.push("comment");
    return this.add(n, body, { login: "owner", id: OWNER, type: "User" }).id;
  }

  async editComment(_repo: string, id: number, body: string) {
    this.calls.push("editComment");
    for (const list of this.comments_.values()) {
      const c = list.find((x) => x.id === id);
      if (c) {
        c.body = body;
        c.updatedAt = "2026-11-11T12:00:00Z";
      }
    }
  }

  async updateIssue(_repo: string, n: number, patch: { body?: string; labels?: string[]; state?: "open" | "closed" }) {
    this.calls.push(`update:${Object.keys(patch).join(",")}`);
    const i = this.issues.get(n)!;
    if (patch.body !== undefined) i.body = patch.body;
    if (patch.labels) i.labels = patch.labels;
    if (patch.state) i.state = patch.state;
  }
}
