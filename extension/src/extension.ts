import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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

// argument list, no shell: item data never reaches a command line parser (SR-4)
const git = (cwd: string, args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile("git", args, { cwd }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())),
  );

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
    await tree.reload();
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
      const root = workspaceRoots().find((r) => r.name === current.repo);
      if (!root) return;
      if (msg?.type === "action") await act(root, current, msg);
      else if (msg?.type === "link") await follow(resolveLink(root.repoDir, current.item.links?.[msg.index] ?? { kind: "", ref: "" }));
      else if (msg?.type === "href" && typeof msg.href === "string") await follow(resolveLink(root.repoDir, { kind: "link", ref: msg.href }));
    });
  };

  const act = async (root: RepoRoot, entry: QueueEntry, msg: { action?: string; option?: string; note?: string }) => {
    const note = typeof msg.note === "string" && msg.note.trim() ? msg.note.trim() : undefined;
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
    try {
      await performAction(root, entry, action, git);
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

function nonce(): string {
  return randomBytes(16).toString("base64");
}
