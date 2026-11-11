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
