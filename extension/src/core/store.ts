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
      const result = parseItem(await fs.readFile(file, "utf8"), file);
      if (result.ok) entries.push({ repo: root.name, path: file, item: result.item });
      else errors.push(result.error);
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
