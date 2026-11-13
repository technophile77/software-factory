import type { EndpointRoute } from "../agent/endpoint-service";
import { type ReviewerRunInput, runReviewerSessions } from "../agent/reviewer";
import type { SessionGroup } from "../agent/sandbox";
import type { AdvisorySession } from "./advisory";
import { readReportFile } from "./report";

/** Inputs for one advisory session: the gate's own reviewer inputs, minus what the endpoint changes. */
export interface AdvisorySessionInput {
  route: EndpointRoute;
  /** A group built with `route.router`; it is closed when the session ends. */
  group: SessionGroup;
  /** The engine-owned folder this session's report goes to (never the gate's own) and the report's file name. */
  reportDir: string;
  reportName: string;
  maxBytes: number;
  /** The reviewer's inputs: same first turn, instructions, policy and worktree as the Claude run (FR-10). */
  run: Omit<ReviewerRunInput, "group" | "model" | "upstream" | "check" | "onUsed" | "onSessionId" | "resume" | "used">;
}

/**
 * Runs the gate role once on its endpoint, read-only, with no correction
 * turn: whatever report it wrote is handed back as text for `parseAdvisory`
 * to check (SR-10). A cap, an error or a change outside the report ends the
 * session as a failure, with what it used still counted.
 *
 * @see runReviewerSessions
 */
export async function runAdvisorySession(i: AdvisorySessionInput): Promise<AdvisorySession> {
  let text = null as string | null;
  const r = await runReviewerSessions({
    ...i.run, group: i.group, model: i.route.sdkModel, upstream: i.route.upstream,
    check: async () => {
      const read = readReportFile(i.reportDir, i.reportName, i.maxBytes);
      text = "text" in read ? read.text : null;
      return null;
    },
    onUsed: () => undefined,
    onSessionId: () => undefined,
  });
  return {
    text: r.invalid === null ? text : null,
    usage: { inputTokens: r.outcome.inputTokens, outputTokens: r.outcome.outputTokens, requests: r.outcome.turns },
    failure: r.invalid,
  };
}
