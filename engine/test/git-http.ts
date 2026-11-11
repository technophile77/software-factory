import { spawn } from "node:child_process";
import * as http from "node:http";
import { AddressInfo } from "node:net";

/**
 * Git smart HTTP on loopback through `git http-backend`, serving the bare
 * repos under `root` as `<base>/<owner>/<repo>.git`. Pushes need the token as
 * the Basic password; each push is recorded with what it authenticated with.
 */
export class GitHttp {
  readonly pushes: Array<{ path: string; user: string; password: string }> = [];
  fetches = 0;
  private server!: http.Server;
  base = "";

  constructor(private readonly root: string, private readonly token: string) {}

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const push = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
    const auth = req.headers.authorization ?? "";
    const [user = "", ...rest] = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":") : [];
    const password = rest.join(":");
    if (push && password !== this.token) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end();
      return;
    }
    if (push && url.pathname.endsWith("/git-receive-pack")) this.pushes.push({ path: url.pathname, user, password });
    if (url.pathname.endsWith("/git-upload-pack")) this.fetches++;
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        REQUEST_METHOD: req.method ?? "GET",
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        REMOTE_ADDR: "127.0.0.1",
        ...(push ? { REMOTE_USER: "factory" } : {}),
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let body = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (body) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf("\r\n\r\n");
      if (sep < 0) return;
      body = true;
      for (const line of head.subarray(0, sep).toString().split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") res.statusCode = parseInt(v, 10);
        else res.setHeader(k, v);
      }
      res.write(head.subarray(sep + 4));
    });
    await new Promise<void>((r) => cgi.on("close", () => r()));
    res.end();
  }
}
