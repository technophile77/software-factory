import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActionError } from "./core/actions";
import { resolveLink } from "./core/links";
import { countOpenBlocking, groupByStatus } from "./core/queue";
import { renderCard } from "./core/render";
import { loadInbox, performAction } from "./core/store";
import type { ItemError, OwnerAction, QueueEntry, RepoRoot, ResolvedLink } from "./core/types";

type Node =
  | { kind: "group"; label: string; entries: QueueEntry[] }
  | { kind: "entry"; entry: QueueEntry }
  | { kind: "error"; error: ItemError }
  | { kind: "empty" };

const MAX_NOTE = 4000;

// Run git by absolute path: a bare "git" with cwd inside .factory/ would let a
// planted .factory/git.exe run on Windows, which searches cwd first. Argument
// list and no shell, so item data never reaches a command-line parser (SR-4).
// Literal pathspecs stop a file name like "*.md" from staging other items.
function makeGit(gitPath: string) {
  return (cwd: string, args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile(
        gitPath,
        args,
        { cwd, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } },
        (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()),
      ),
    );
}

async function findGit(): Promise<string | undefined> {
  // Prefer the path VS Code's own Git extension already resolved.
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    const api = (ext?.isActive ? ext.exports : await ext?.activate())?.getAPI(1);
    if (api?.git?.path && path.isAbsolute(api.git.path)) return api.git.path;
  } catch {
    // fall through to PATH search
  }
  const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => path.resolve(f.uri.fsPath));
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const abs = path.resolve(dir);
    if (workspaceDirs.some((w) => abs === w || abs.startsWith(w + path.sep))) continue;
    for (const n of names) {
      const candidate = path.join(abs, n);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function workspaceRoots(): RepoRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    repoDir: f.uri.fsPath,
    factoryDir: path.join(f.uri.fsPath, ".factory"),
  }));
}

class DecisionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  entries: QueueEntry[] = [];
  errors: ItemError[] = [];

  async reload(): Promise<void> {
    ({ entries: this.entries, errors: this.errors } = await loadInbox(workspaceRoots()));
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === "group") return node.entries.map((entry) => ({ kind: "entry", entry }));
    if (node) return [];
    const { open, deferred, decided } = groupByStatus(this.entries);
    const top: Node[] = this.errors.map((error) => ({ kind: "error", error }));
    if (open.length) top.push({ kind: "group", label: `Open (${open.length})`, entries: open });
    if (deferred.length) top.push({ kind: "group", label: `Deferred (${deferred.length})`, entries: deferred });
    if (decided.length) top.push({ kind: "group", label: `Decided (${decided.length})`, entries: decided });
    return top.length ? top : [{ kind: "empty" }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "group": {
        const t = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        if (node.label.startsWith("Decided")) t.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        return t;
      }
      case "entry": {
        const { item, repo } = node.entry;
        const t = new vscode.TreeItem(`${item.id} ${item.title}`);
        t.description = `${repo} · ${item.category ?? ""} · ${item.effective_priority}`;
        t.iconPath = new vscode.ThemeIcon(
          item.blocking ? "error" : "circle-outline",
          item.blocking ? new vscode.ThemeColor("errorForeground") : undefined,
        );
        t.tooltip = item.blocking ? "Blocks work" : undefined;
        t.command = { command: "softwareFactory.openItem", title: "Open", arguments: [node.entry] };
        return t;
      }
      case "error": {
        const t = new vscode.TreeItem(path.basename(node.error.path));
        t.description = node.error.message;
        t.iconPath = new vscode.ThemeIcon("warning");
        t.resourceUri = vscode.Uri.file(node.error.path);
        t.command = { command: "vscode.open", title: "Open file", arguments: [vscode.Uri.file(node.error.path)] };
        return t;
      }
      case "empty":
        return new vscode.TreeItem("No decisions waiting.");
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tree = new DecisionTree();
  const view = vscode.window.createTreeView("softwareFactory.decisions", { treeDataProvider: tree });
  const panels = new Map<string, vscode.WebviewPanel>();

  const refresh = async () => {
    try {
      await tree.reload();
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not load the decision inbox: ${(e as Error).message}`);
      return;
    }
    const blocking = countOpenBlocking(tree.entries);
    view.badge = blocking ? { value: blocking, tooltip: `${blocking} blocking decision(s)` } : undefined;
    for (const [file, panel] of panels) {
      const entry = tree.entries.find((e) => e.path === file);
      if (entry) panel.webview.html = renderCard(entry, nonce());
    }
  };

  const open = (entry: QueueEntry) => {
    const existing = panels.get(entry.path);
    if (existing) return existing.reveal();
    const panel = vscode.window.createWebviewPanel("softwareFactory.item", entry.item.id, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [],
    });
    panels.set(entry.path, panel);
    panel.onDidDispose(() => panels.delete(entry.path));
    panel.webview.html = renderCard(entry, nonce());
    panel.webview.onDidReceiveMessage(async (msg) => {
      const current = tree.entries.find((e) => e.path === entry.path) ?? entry;
      // Find the repo by path, not folder name: two open folders can share a name.
      const root = workspaceRoots().find((r) => isInside(r.factoryDir, current.path));
      if (!root || typeof msg !== "object" || msg === null) return;
      if (msg.type === "action") await act(root, current, msg);
      else if (msg.type === "link") {
        const links = current.item.links ?? [];
        if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < links.length) {
          await follow(resolveLink(root.repoDir, links[msg.index]));
        }
      } else if (msg.type === "href" && typeof msg.href === "string" && msg.href.length <= 2048) {
        await follow(resolveLink(root.repoDir, { kind: "link", ref: msg.href }));
      }
    });
  };

  const act = async (root: RepoRoot, entry: QueueEntry, msg: { action?: string; option?: string; note?: string }) => {
    const note = typeof msg.note === "string" && msg.note.trim() ? msg.note.trim().slice(0, MAX_NOTE) : undefined;
    const option = typeof msg.option === "string" ? msg.option : undefined;
    let action: OwnerAction;
    switch (msg.action) {
      case "approve": action = { type: "approve", option, note }; break;
      case "reject": action = { type: "reject", note }; break;
      case "request_changes": action = { type: "request_changes", note: note ?? "" }; break;
      case "request_research": action = { type: "request_research", note: note ?? "" }; break;
      case "defer": action = { type: "defer", note }; break;
      case "restore": action = { type: "restore" }; break;
      default: return;
    }
    const gitPath = await findGit();
    if (!gitPath) {
      void vscode.window.showErrorMessage("Git was not found, so the action was not recorded.");
      return;
    }
    try {
      await performAction(root, entry, action, makeGit(gitPath));
      await refresh();
    } catch (e) {
      const text = e instanceof ActionError ? e.message : `Could not record the action: ${(e as Error).message}`;
      void vscode.window.showErrorMessage(text);
    }
  };

  const follow = async (link: ResolvedLink) => {
    if (link.kind === "refused") return void vscode.window.showWarningMessage(`Link not opened: ${link.reason}`);
    if (link.kind === "url") return void vscode.env.openExternal(vscode.Uri.parse(link.url));
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(link.absPath));
  };

  const watcher = vscode.workspace.createFileSystemWatcher("**/.factory/inbox/decision/*.md");
  // Coalesce bursts (an agent writing several items) into one reload.
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 200);
  };
  watcher.onDidCreate(schedule);
  watcher.onDidChange(schedule);
  watcher.onDidDelete(schedule);

  context.subscriptions.push(
    view,
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.commands.registerCommand("softwareFactory.refresh", refresh),
    vscode.commands.registerCommand("softwareFactory.openItem", open),
  );
  void refresh();
}

export function deactivate(): void {}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}
