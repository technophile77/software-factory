import { describe, it, expect } from "vitest";
import { renderCard } from "../../src/core/render";
import type { QueueEntry, InboxItem } from "../../src/core/types";
import { makeItem } from "./fixtures";

const NONCE = "T3stN0nce1234567890abcdef";

function card(over: Partial<InboxItem> = {}, repo = "repo-a"): string {
  const item = makeItem(over);
  const entry: QueueEntry = { repo, path: `/${repo}/.factory/inbox/decision/${item.id}.md`, item };
  return renderCard(entry, NONCE);
}

/** Visible text: tags removed, common entities decoded. */
function text(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("AC-9 / FR-4: card shows every decision-card field", () => {
  const html = card({ blocking: true });
  const t = text(html);

  it("AC-9: shows the title", () => expect(t).toContain("Choose session store for login"));
  it("AC-9: shows the category", () => expect(t).toContain("Architecture"));
  it("AC-9: shows the priority", () => expect(t.toLowerCase()).toContain("high"));
  it("AC-9: shows the status", () => expect(t.toLowerCase()).toContain("open"));
  it("AC-9: shows blocking", () => expect(t.toLowerCase()).toContain("blocking"));
  it("AC-9: shows the Context section", () => {
    expect(t).toContain("Context");
    expect(t).toContain("We need a session store for login.");
  });
  it("AC-9: shows options with pros and cons", () => {
    expect(t).toContain("Redis");
    expect(t).toContain("Postgres table");
    expect(t).toContain("fast lookups");
    expect(t).toContain("another service to run");
    expect(t).toContain("no new infrastructure");
    expect(t).toContain("slower under load");
  });
  it("AC-9: shows the project impact", () => {
    expect(t).toContain("Project impact");
    expect(t).toContain("Affects F-012 login only.");
  });
  it("AC-9: shows the recommendation", () => {
    expect(t).toContain("Recommendation");
    expect(t).toContain("latency matters most");
  });
  it("AC-9: shows the cost of delay", () => {
    expect(t).toContain("Cost of delay");
    expect(t).toContain("Blocks F-012 build stage.");
  });
  it("AC-9: deferred card shows the effective priority distinct from filed priority", () => {
    const d = text(card({ priority: "critical", effective_priority: "high", status: "deferred" })).toLowerCase();
    expect(d).toContain("critical");
    expect(d).toContain("high");
    expect(d).toContain("deferred");
  });
  it("FR-12: card is labeled with its repo", () => {
    expect(text(card({}, "billing-service"))).toContain("billing-service");
  });
});

describe("SR-1: webview content security policy", () => {
  const html = card();

  it("SR-1: has a CSP meta tag with default-src 'none' and nonce-only scripts and styles", () => {
    const m = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
    expect(m, "CSP meta tag").not.toBeNull();
    const csp = m![0];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${NONCE}'`);
    expect(csp).toContain(`style-src 'nonce-${NONCE}'`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it("SR-1: every script tag carries the nonce", () => {
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    for (const s of scripts) expect(s).toContain(`nonce="${NONCE}"`);
  });

  it("SR-1: no remote resources are referenced", () => {
    expect(html).not.toMatch(/\bsrc\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/<link\b[^>]*href\s*=\s*["']?(https?:)?\/\//i);
  });
});

describe("AC-12 / SR-1: untrusted body is rendered inert", () => {
  const body = [
    "## Context",
    "<script>alert('pwned')</script>",
    "",
    '<img src="x" onerror="alert(1)">',
    "",
    '<div onclick="alert(2)">click</div>',
    "",
    "[click me](javascript:alert(3))",
    "",
    "<iframe src=\"https://evil.example\"></iframe>",
    "",
    "## Options",
    "## Project impact",
    "## Recommendation",
    "## Cost of delay",
  ].join("\n");
  const html = card({ body } as Partial<InboxItem>);

  it("AC-12: a <script> in the body does not appear as a live script tag", () => {
    expect(html).not.toMatch(/<script>\s*alert/i);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    for (const s of scripts) expect(s).toContain(`nonce="${NONCE}"`);
    expect(html).not.toContain("alert('pwned')</script>");
  });

  it("AC-12: an onerror attribute in the body does not appear on any live tag", () => {
    expect(html).not.toMatch(/<[a-z][^>]*\sonerror\s*=/i);
    expect(html).not.toMatch(/<img\b/i);
  });

  it("AC-12: no inline event handler from the body appears on any live tag", () => {
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=\s*["']?alert/i);
  });

  it("AC-12: no javascript: link is produced", () => {
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it("AC-12: no iframe from the body is produced", () => {
    expect(html).not.toMatch(/<iframe\b/i);
  });

  it("AC-12: the dangerous text is shown inert (escaped), not dropped", () => {
    expect(html).toMatch(/&lt;script&gt;/i);
    expect(text(html)).toContain("<script>alert('pwned')</script>");
  });

  it("SR-1: HTML in frontmatter fields (title, option labels) is escaped too", () => {
    const h = card({
      title: '<img src=x onerror="alert(4)">Title',
      options: [{ id: "A", label: "<script>alert(5)</script>" }],
      recommendation: "A",
    });
    expect(h).not.toMatch(/<img\b/i);
    expect(h).not.toMatch(/<script>\s*alert/i);
  });

  it("SR-1: a very long body renders without error and stays inert", () => {
    const long = "## Context\n" + "<script>x</script> lorem ipsum ".repeat(20000);
    const h = card({ body: long } as Partial<InboxItem>);
    expect(h).not.toMatch(/<script>x/i);
  });
});
