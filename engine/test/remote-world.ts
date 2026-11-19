import * as fs from "node:fs";
import * as path from "node:path";
import { GitHttp } from "./git-http";
import { FACTORY_TOKEN, addProjectFile, type World, git, makeWorld, tmpdir } from "./helpers";

/** A world whose config repo's origin is a bare repo served over loopback git HTTP. */
export async function remoteWorld(): Promise<{ w: World; srv: GitHttp; bare: string }> {
  const w = makeWorld();
  const root = path.join(w.root, "remote");
  const bare = path.join(root, "example-org", "acme-config.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(w.root, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "http.receivepack", "true");
  git(w.config, "push", "-q", bare, "main");
  const srv = await new GitHttp(root, FACTORY_TOKEN).start();
  git(w.config, "remote", "set-url", "origin", `${srv.base}/example-org/acme-config`);
  w.github.webBase = srv.base;
  // F-023 FR-2: the project file names the config repo on the GitHub the engine is given.
  addProjectFile(w.master, "acme", w.config, `${srv.base}/example-org/acme-config`);
  return { w, srv, bare };
}

/** Commits `files` on the remote's factory/state as someone other than the engine. */
export function forge(w: World, bare: string, files: Record<string, string>): string {
  const tmp = tmpdir();
  git(w.root, "clone", "-q", "-b", "factory/state", bare, tmp);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), c);
  }
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "someone else");
  git(tmp, "push", "-q", "origin", "factory/state");
  return git(tmp, "rev-parse", "HEAD");
}

