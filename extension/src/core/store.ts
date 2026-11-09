import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyAction } from "./actions";
import { isValidItemId, parseItem, serializeItem } from "./item";
import type { GitRunner, InboxItem, ItemError, OwnerAction, QueueEntry, RepoRoot } from "./types";

export function decisionDir(root: RepoRoot): string {
  return path.join(root.factoryDir, "inbox", "decision");
}

export async function loadInbox(roots: RepoRoot[]): Promise<{ entries: QueueEntry[]; errors: ItemError[] }> {
  const entries: QueueEntry[] = [];
  const errors: ItemError[] = [];
  for (const root of roots) {
    const dir = decisionDir(root);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // No inbox in this repo yet; that's the normal empty state.
    }
    for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
      const file = path.join(dir, name);
      let text: string;
      try {
        const stat = await fs.lstat(file);
        // Symlinks could show a file from outside the repo as an item.
        if (!stat.isFile()) throw new Error("not a regular file");
        text = await fs.readFile(file, "utf8");
      } catch (e) {
        // One unreadable entry must not hide the rest of the inbox.
        errors.push({ path: file, message: `cannot read: ${(e as Error).message}` });
        continue;
      }
      const result = parseItem(text, file);
      if (!result.ok) errors.push(result.error);
      else if (name !== `${result.item.id}.md`) {
        errors.push({ path: file, message: `file name must be ${result.item.id}.md` });
      } else entries.push({ repo: root.name, path: file, item: result.item });
    }
  }
  return { entries, errors };
}

export async function performAction(
  root: RepoRoot,
  entry: QueueEntry,
  action: OwnerAction,
  git: GitRunner,
  now: () => string = () => new Date().toISOString(),
): Promise<InboxItem> {
  // Re-read so an agent's edit since the view loaded isn't overwritten.
  const original = await fs.readFile(entry.path, "utf8");
  const result = parseItem(original, entry.path);
  if (!result.ok) throw new Error(result.error.message);
  const current = result.item;
  if (!isValidItemId(current.id)) throw new Error(`invalid id: ${current.id}`);
  if (path.basename(entry.path) !== `${current.id}.md`) {
    throw new Error(`file name must be ${current.id}.md`);
  }

  const updated = applyAction(current, action, now());

  await writeAtomic(entry.path, serializeItem(updated));

  const rel = path.relative(root.factoryDir, entry.path);
  const verb = updated.history[updated.history.length - 1].action;
  try {
    await git(root.factoryDir, ["add", "--", rel]);
    await git(root.factoryDir, ["commit", "-m", `${updated.id}: ${verb}`, "--", rel]);
  } catch (e) {
    // An action only counts once it's committed (FR-8). Put the file back so
    // an uncommitted change can't ride along with a later commit.
    await writeAtomic(entry.path, original);
    await git(root.factoryDir, ["reset", "--quiet", "--", rel]).catch(() => undefined);
    throw e;
  }
  return updated;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}
