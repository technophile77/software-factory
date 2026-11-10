# Core module API (F-001)

Internal API of the extension's core, free of VS Code imports. Types are in
`types.ts`. Acceptance tests target these functions.

| Module | Function | Behavior |
|---|---|---|
| `item.ts` | `parseItem(text: string, path: string): ParseResult` | Parses a Markdown file with YAML frontmatter per Inbox item v1.0. Returns `{ok:false}` with a message for missing frontmatter, invalid YAML, missing required fields, unknown enum values, or an id not matching `^[DTH]-\d{4,}$`. Unknown fields go to `extra`. |
| `item.ts` | `serializeItem(item: InboxItem): string` | Inverse of `parseItem`; keeps `extra` fields. `parseItem(serializeItem(x))` equals `x`. |
| `item.ts` | `isValidItemId(id: string): boolean` | `^[DTH]-\d{4,}$` |
| `queue.ts` | `sortQueue(entries: QueueEntry[]): QueueEntry[]` | Sort by `effective_priority` (critical > high > medium > low), then `created_at` oldest first, then repo name, then id. Does not mutate input. |
| `queue.ts` | `groupByStatus(entries: QueueEntry[]): { open: QueueEntry[]; deferred: QueueEntry[]; decided: QueueEntry[] }` | `decided` = approved, rejected; `changes_requested` and `research_requested` count as open. Each group sorted with `sortQueue`. |
| `queue.ts` | `countOpenBlocking(entries: QueueEntry[]): number` | Items with `blocking: true` that are not yet approved or rejected (open, deferred, changes or research requested). |
| `actions.ts` | `applyAction(item: InboxItem, action: OwnerAction, at: string): InboxItem` | Returns a new item. Throws `ActionError` when: approving without `option` when the item has options, or with an option id not in the list; request_changes / request_research without a non-empty note; restore on an item that isn't deferred; any action on an approved or rejected item. Defer lowers `effective_priority` one step (low stays low), sets status `deferred`, keeps `blocking`. Restore sets `effective_priority = priority`, status `open`. Appends a history entry `{at, by: "owner", action, option?, note?}`. |
| `links.ts` | `resolveLink(repoDir: string, link: ItemLink): ResolvedLink` | `kind: "url"` only for `https:` URLs. File refs resolve relative to `repoDir` and are refused if the real path is outside it. Everything else refused. |
| `render.ts` | `renderCard(entry: QueueEntry, nonce: string): string` | Full HTML for the detail webview. Body Markdown rendered with raw HTML disabled. CSP: `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'`. Shows every decision-card field. |
| `store.ts` | `loadInbox(roots: RepoRoot[]): Promise<{ entries: QueueEntry[]; errors: ItemError[] }>` | Reads `<factoryDir>/inbox/decision/*.md` for every root. Missing folders give no entries and no errors. |
| `store.ts` | `performAction(root: RepoRoot, entry: QueueEntry, action: OwnerAction, git: GitRunner, now?: () => string): Promise<InboxItem>` | Re-reads the file, refuses if the file name isn't `<id>.md`, applies the action, writes atomically (temp file + rename), then runs `git add -- <file>` and `git commit -m "<id>: <action>" -- <file>` in `root.factoryDir`. On a git failure it restores the original file and rethrows. The caller's `GitRunner` must run git by absolute path with literal pathspecs (see `git.ts`). |
| `git.ts` | `findGitOnPath(pathEnv, workspaceDirs, platform, exists)` | First `git`/`git.exe` on PATH, skipping relative entries and any folder inside an open workspace folder; case-insensitive on Windows. |
| `git.ts` | `isWithin(root, target)` | `target` is `root` or below it. Names that merely start with `..` count as inside. |
