import MarkdownIt from "markdown-it";
import type { QueueEntry } from "./types";

// Item bodies are written by agents that read untrusted content, so raw HTML
// is off and links can't use javascript: or similar schemes (SR-1).
const md = new MarkdownIt({ html: false, linkify: false });

export function renderCard(entry: QueueEntry, nonce: string): string {
  const { item, repo } = entry;
  const field = (label: string, value: string) =>
    `<div class="field"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;

  const options = (item.options ?? [])
    .map((o) => {
      const recommended = o.id === item.recommendation ? ' <span class="badge">recommended</span>' : "";
      return `<li><label><input type="radio" name="option" value="${esc(o.id)}"> <strong>${esc(o.id)}</strong> ${esc(o.label)}${recommended}</label></li>`;
    })
    .join("");

  const links = (item.links ?? [])
    .map((l, i) => `<li><a href="#" data-link="${i}">${esc(l.kind)}: ${esc(l.ref)}</a></li>`)
    .join("");

  const history = item.history
    .map((h) => `<li>${esc(h.at)} · ${esc(h.by)} · ${esc(h.action)}${h.option ? ` (${esc(h.option)})` : ""}${h.note ? `: ${esc(h.note)}` : ""}</li>`)
    .join("");

  const decided = item.status === "approved" || item.status === "rejected";
  const actions = decided
    ? ""
    : `<div class="actions">
        <button data-action="approve">Approve</button>
        <button data-action="reject">Reject</button>
        <button data-action="request_changes">Request changes</button>
        <button data-action="request_research">Ask for more research</button>
        ${item.status === "deferred" ? '<button data-action="restore">Restore priority</button>' : '<button data-action="defer">Defer</button>'}
        <textarea id="note" placeholder="Note (required for changes or research)"></textarea>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin-bottom: 16px; }
  .field { display: contents; }
  .label { color: var(--vscode-descriptionForeground); }
  .blocking { color: var(--vscode-errorForeground); font-weight: bold; }
  .badge { font-size: 0.85em; padding: 0 6px; border: 1px solid var(--vscode-focusBorder); border-radius: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
  .actions textarea { flex-basis: 100%; min-height: 3em; }
  ul.options { list-style: none; padding: 0; }
</style>
</head>
<body>
<h1>${esc(item.id)} · ${esc(item.title)}</h1>
<div class="meta">
  ${field("Repo", repo)}
  ${field("Category", item.category ?? "—")}
  ${field("Priority", item.effective_priority === item.priority ? item.priority : `${item.effective_priority} (deferred from ${item.priority})`)}
  ${field("Status", item.status)}
  <div class="field"><span class="label">Blocking</span><span class="value${item.blocking ? " blocking" : ""}">${item.blocking ? "Yes, blocks work" : "No"}</span></div>
  ${item.feature ? field("Feature", item.feature) : ""}
  ${field("Filed by", `${item.created_by}, ${item.created_at}`)}
  ${field("Recommendation", item.recommendation ?? "—")}
</div>
${options ? `<h2>Options</h2><ul class="options">${options}</ul>` : ""}
<div class="body">${md.render(item.body)}</div>
${links ? `<h2>Links</h2><ul>${links}</ul>` : ""}
${actions}
<h2>History</h2><ul>${history}</ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => {
    const picked = document.querySelector('input[name="option"]:checked');
    vscode.postMessage({
      type: "action",
      action: b.dataset.action,
      option: picked ? picked.value : undefined,
      note: document.getElementById("note").value,
    });
  }));
  document.querySelectorAll("[data-link]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "link", index: Number(a.dataset.link) });
  }));
  // Links inside the body go through the same checks as item links (SR-3).
  document.querySelectorAll(".body a[href]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "href", href: a.getAttribute("href") });
  }));
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
