import YAML from "yaml";
import { Clock, iso } from "../clock";
import type { StateRepo } from "./state-repo";

export interface SecurityAlert {
  title: string;
  feature?: string;
  context: string;
  impact: string;
  /** Option A is what the owner does if the change is theirs; B keeps things stopped. */
  confirm: string;
  hold: string;
  recommendation: "A" | "B";
}

/**
 * Files a Security item in the decision inbox (Inbox item v1.1) on the repo's
 * factory/state. Callers pass engine-written text only: never secrets,
 * owner replies or analyst text.
 */
export async function fileSecurityItem(state: StateRepo, clock: Clock, a: SecurityAlert): Promise<string> {
  const existing = await state.list("inbox/decision").catch(() => []);
  let max = 0;
  for (const e of existing) {
    const m = /(?:^|\/)D-(\d{4,})\.md$/.exec(e.path);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const id = `D-${String(max + 1).padStart(4, "0")}`;
  const at = iso(clock.now());
  const front: Record<string, unknown> = {
    schema: "inbox-item/1.0",
    id,
    inbox: "decision",
    title: a.title,
    category: "Security",
    priority: "high",
    effective_priority: "high",
    blocking: true,
    status: "open",
    ...(a.feature ? { feature: a.feature } : {}),
    created_by: "engine",
    created_at: at,
    options: [
      { id: "A", label: a.confirm },
      { id: "B", label: a.hold },
    ],
    recommendation: a.recommendation,
    links: [],
    history: [{ at, by: "engine", action: "filed" }],
  };
  const body = [
    `## Context\n\n${a.context}`,
    `## Options\n\n- **A. ${a.confirm}.** Pro: work resumes. Con: wrong if you didn't make the change.\n- **B. ${a.hold}.** Pro: nothing runs until you've looked. Con: the project stays stopped.`,
    `## Project impact\n\n${a.impact}`,
    `## Recommendation\n\nOption ${a.recommendation}.`,
    "## Cost of delay\n\nThe affected work stays stopped until this is decided.",
  ].join("\n\n");
  const text = `---\n${YAML.stringify(front)}---\n\n${body}\n`;
  await state.commit([{ path: `inbox/decision/${id}.md`, content: text }], `${id}: ${a.title}`);
  return id;
}

export interface DecisionItem {
  title: string;
  feature?: string;
  /** Engine words, or reviewer text already made plain (F-008 SR-4). */
  context: string;
  impact: string;
  /** `label` goes in the front matter as a YAML string; `shown` is the body's Markdown form of it, if different. */
  options: Array<{ id: string; label: string; shown?: string; detail?: string }>;
  recommendation: string;
  costOfDelay: string;
}

/**
 * A Security item with any 2 to 4 options (F-008 FR-8, FR-13). The front
 * matter is engine-written only; labels go in it as YAML strings, so they
 * can't add keys. The commit runs the secrets scan (SR-9).
 */
export async function fileDecisionItem(state: StateRepo, clock: Clock, d: DecisionItem): Promise<string> {
  if (d.options.length < 2 || d.options.length > 4 || !d.options.some((o) => o.id === d.recommendation)) throw new Error("a decision item needs 2 to 4 options and one of them recommended");
  const existing = await state.list("inbox/decision").catch(() => []);
  let max = 0;
  for (const e of existing) {
    const m = /(?:^|\/)D-(\d{4,})\.md$/.exec(e.path);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const id = `D-${String(max + 1).padStart(4, "0")}`;
  const at = iso(clock.now());
  const front: Record<string, unknown> = {
    schema: "inbox-item/1.0", id, inbox: "decision", title: d.title, category: "Security",
    priority: "high", effective_priority: "high", blocking: true, status: "open",
    ...(d.feature ? { feature: d.feature } : {}),
    created_by: "engine", created_at: at,
    options: d.options.map((o) => ({ id: o.id, label: o.label })),
    recommendation: d.recommendation, links: [], history: [{ at, by: "engine", action: "filed" }],
  };
  const body = [
    `## Context\n\n${d.context}`,
    `## Options\n\n${d.options.map((o) => `- **${o.id}. ${o.shown ?? o.label}.**${o.detail ? ` ${o.detail}` : ""}`).join("\n")}`,
    `## Project impact\n\n${d.impact}`,
    `## Recommendation\n\nOption ${d.recommendation}.`,
    `## Cost of delay\n\n${d.costOfDelay}`,
  ].join("\n\n");
  await state.commit([{ path: `inbox/decision/${id}.md`, content: `---\n${YAML.stringify(front)}---\n\n${body}\n` }], `${id}: ${d.title}`);
  return id;
}
