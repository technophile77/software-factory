import type { Inbox } from "../inbox/store";
import type { Effect, Part } from "../inbox/model";
import { actionLabel } from "../inbox/render";

export interface SecurityAlert {
  title: string;
  feature?: string;
  context: string;
  impact: string;
  /** Option A is what the owner does if the change is theirs; B keeps things stopped. */
  confirm: string;
  hold: string;
  recommendation: "A" | "B";
  /** Engine values the item's effect needs, such as the manifest commit a pins item names (Gate 2 M2). */
  effectData?: Record<string, string | number>;
}

/**
 * Files an engine Security item (F-011 Inbox item v3.0) as an inbox issue.
 * Callers pass engine-written text only: never secrets, owner replies or
 * analyst text. `type` is the alert's kind (the part of its key before the
 * first colon); it picks the item's effect when the owner answers, fixed in
 * code (F-016 FR-6, H-0182, SR-4).
 */
export async function fileSecurityItem(inbox: Inbox, type: string, a: SecurityAlert): Promise<string> {
  return inbox.file({
    kind: "decision", title: a.title, category: "Security", priority: "high", blocking: true, created_by: "engine",
    ...(a.feature ? { feature: a.feature } : {}),
    options: [{ id: "A", label: a.confirm }, { id: "B", label: a.hold }],
    recommendation: a.recommendation,
    effect: { ...a.effectData, type, ...(a.feature ? { feature: a.feature } : {}) },
    sections: {
      Context: [{ engine: a.context }],
      Options: [{ engine: `- **A. ${a.confirm}.** Pro: work resumes. Con: wrong if you didn't make the change.\n- **B. ${a.hold}.** Pro: nothing runs until you've looked. Con: the project stays stopped.` }],
      "Project impact": [{ engine: a.impact }],
      Recommendation: [{ engine: `Option ${a.recommendation}.` }],
      "Cost of delay": [{ engine: "The affected work stays stopped until this is decided." }],
    },
  });
}

export interface DecisionItem {
  title: string;
  feature?: string;
  /** Engine words, and reviewer text as outside parts (F-011 SR-10). */
  context: Part[];
  impact: string;
  options: Array<{ id: string; label: string; detail?: string }>;
  /** Who wrote the labels, when not the engine; the body then fences them (SR-10). */
  optionsBy?: string;
  recommendation: string;
  costOfDelay: string;
  effect: Effect;
}

/** A Security item with 2 to 4 options (F-008 FR-8, FR-13). Labels are rendered as plain text by the inbox. */
export async function fileDecisionItem(inbox: Inbox, d: DecisionItem): Promise<string> {
  const options = d.options.map((o) => ({ id: o.id, label: o.label.replace(/\s+/g, " ").trim() }));
  return inbox.file({
    kind: "decision", title: d.title, category: "Security", priority: "high", blocking: true, created_by: "engine",
    ...(d.feature ? { feature: d.feature } : {}),
    options,
    recommendation: d.recommendation,
    effect: d.effect,
    sections: {
      Context: d.context,
      // Inbox item v3.1: the options numbered in the body too, besides their action comments.
      Options: d.optionsBy
        ? [
          { engine: "The options, in the order of their action comments:" },
          { outside: options.map((o, i) => `${i + 1}. ${o.id}: ${o.label}`).join("\n"), author: d.optionsBy },
          ...d.options.filter((o) => o.detail).map((o) => ({ engine: `${o.id}: ${o.detail}` })),
          { engine: "To choose, react 👍 on that option's action comment below." },
        ]
        : [
          ...options.map((o, i) => ({ engine: `${i + 1}. ${actionLabel({ options }, `choose:${o.id}`)}.${d.options[i]!.detail ? ` ${d.options[i]!.detail}` : ""}` })),
          { engine: "To choose, react 👍 on that option's action comment below." },
        ],
      "Project impact": [{ engine: d.impact }],
      Recommendation: [{ engine: `Option ${d.recommendation}.` }],
      "Cost of delay": [{ engine: d.costOfDelay }],
    },
  });
}
