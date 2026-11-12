import { Clock } from "../clock";
import { ID_RE, MAX_NEXT_WAIT_S, REFUSED_MESSAGE, RPC } from "../constants";
import { DocumentRefused, SourceDocument, validateDocument } from "../interview/document";
import { FeatureInterview, InterviewError } from "../interview/feature";
import { wire } from "../interview/model";
import { SecretFound } from "../state/state-repo";
import { Handler, RpcError } from "./framing";
import { SessionManager } from "./sessions";

export interface ProjectChannel {
  name: string;
  sessions: SessionManager;
  /** This project's features with an interview. */
  features(): FeatureInterview[];
  /** One of this project's features, or null (also null for an id two projects share, SR-16). */
  feature(id: string): FeatureInterview | null;
  /** Channel v1.4: `document` has passed validateDocument; the engine scans and stores it (F-009). */
  startFeature(request: string, document?: SourceDocument): Promise<string>;
  /** Files the Security item behind a -32008 for a secret the scan found (H-0084). */
  secretRefused(where: string, found: SecretFound, feature?: string): Promise<void>;
}

export interface EngineControl {
  status(): { version: string; capabilities: string[]; uptime_s: number; features: Array<{ id: string; stage: string; active_agents: number }> };
  pause(feature?: string): string[];
  resume(feature?: string): string[];
  shutdown(): void;
}

const MAX_REQUEST_CHARS = 4000;

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new RpcError(RPC.invalidParams, `${what} must be an id.`);
  return v;
}

function waitS(v: unknown, max: number): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new RpcError(RPC.invalidParams, "wait_s must be a non-negative integer.");
  return Math.min(v, max);
}

function only(params: Record<string, unknown>, keys: string[]): void {
  for (const k of Object.keys(params)) if (!keys.includes(k)) throw new RpcError(RPC.invalidParams, "Unexpected parameter.");
}

/** Channel v1.1-v1.4 methods for one project's channel. Session state never crosses projects (SR-16). */
export function methods(project: ProjectChannel, engine: EngineControl, clock: Clock): Handler {
  const feature = (fid: unknown): FeatureInterview => {
    const f = project.feature(id(fid, "feature"));
    if (!f) throw new RpcError(RPC.unknown, "Unknown feature.");
    return f;
  };

  async function next(f: FeatureInterview, shown: Set<string>, wait: number) {
    const deadline = clock.now() + wait * 1000;
    for (;;) {
      const it = f.pick(shown);
      if (it) return wire(it);
      const busy = f.researching();
      if (!busy || clock.now() >= deadline) return busy ? wire(busy) : null;
      // Wake on the next change to the feature, or at the deadline.
      const ac = new AbortController();
      const onChange = () => ac.abort();
      f.changed.once("change", onChange);
      await clock.sleep(deadline - clock.now(), ac.signal);
      f.changed.off("change", onChange);
    }
  }

  return async (method, p) => {
    switch (method) {
      case "engine.status":
        only(p, []);
        return engine.status();
      case "engine.pause":
        only(p, ["feature"]);
        if (p.feature !== undefined) feature(p.feature);
        return { paused: engine.pause(p.feature as string | undefined) };
      case "engine.resume":
        only(p, ["feature"]);
        if (p.feature !== undefined) feature(p.feature);
        return { resumed: engine.resume(p.feature as string | undefined) };
      case "engine.shutdown":
        only(p, []);
        // Answer first; the engine stops once this reply is on its way.
        setImmediate(() => engine.shutdown());
        return { ok: true };
      case "feature.start": {
        only(p, ["request", "document"]);
        if (typeof p.request !== "string" || !p.request.trim() || [...p.request].length > MAX_REQUEST_CHARS) {
          throw new RpcError(RPC.invalidParams, `request must be non-empty text up to ${MAX_REQUEST_CHARS} characters.`);
        }
        try {
          const doc = p.document === undefined ? undefined : validateDocument(p.document);
          return { feature: await project.startFeature(p.request, doc) };
        } catch (e) {
          // The owner's own document, refused before anything is stored: the client may show lines and rule ids (H-0105).
          if (e instanceof DocumentRefused) throw new RpcError(RPC.documentRefused, e.message, e.data());
          if (e instanceof SecretFound) {
            await project.secretRefused("feature.start", e);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      case "interview.list":
        only(p, []);
        return {
          features: project.features()
            .filter((f) => f.chainIntact)
            .map((f) => ({ id: f.id, title: f.state.title, ...f.state.counts() })),
        };
      case "interview.open": {
        only(p, ["feature", "takeover"]);
        const f = feature(p.feature);
        if (p.takeover !== undefined && typeof p.takeover !== "boolean") throw new RpcError(RPC.invalidParams, "takeover must be true or false.");
        // The Security item was filed when the tampering was found.
        if (!f.chainIntact) throw new RpcError(RPC.refused, REFUSED_MESSAGE);
        return project.sessions.open(f.id, p.takeover === true);
      }
      case "interview.awaitApproval":
        only(p, ["session", "wait_s"]);
        return project.sessions.awaitApproval(p.session, waitS(p.wait_s, 900));
      case "interview.next": {
        only(p, ["session", "wait_s"]);
        const wait = waitS(p.wait_s, MAX_NEXT_WAIT_S);
        const s = project.sessions.approved(p.session);
        return { item: await next(feature(s.feature), s.shown, wait) };
      }
      case "interview.reply": {
        only(p, ["session", "item", "revision", "reply_id", "kind", "text"]);
        const s = project.sessions.approved(p.session);
        const f = feature(s.feature);
        const item = id(p.item, "item");
        const replyId = id(p.reply_id, "reply_id");
        if (typeof p.revision !== "number" || !Number.isSafeInteger(p.revision) || p.revision < 0) {
          throw new RpcError(RPC.invalidParams, "revision must be a non-negative integer.");
        }
        if (typeof p.kind !== "string") throw new RpcError(RPC.invalidParams, "kind must be a string.");
        if (typeof p.text !== "string") throw new RpcError(RPC.invalidParams, "text must be a string.");
        try {
          return await f.reply({ item, revision: p.revision, reply_id: replyId, kind: p.kind, text: p.text }, s.shown);
        } catch (e) {
          if (e instanceof InterviewError) {
            if (e.code === "tampered") throw new RpcError(RPC.refused, REFUSED_MESSAGE);
            const code = { stale: RPC.stale, unknown: RPC.unknown, kind: RPC.kindNotAllowed }[e.code];
            throw new RpcError(code, e.message);
          }
          if (e instanceof SecretFound) {
            await project.secretRefused("interview.reply", e, f.id);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      case "interview.state": {
        only(p, ["feature", "item"]);
        const f = feature(p.feature);
        const it = f.state.items.get(id(p.item, "item"));
        if (!it) throw new RpcError(RPC.unknown, "Unknown item.");
        return { status: it.status, revision: it.revision, ...(it.recorded_at ? { recorded_at: it.recorded_at } : {}) };
      }
      case "interview.close":
        only(p, ["session"]);
        project.sessions.close(p.session);
        return { ok: true };
      default:
        throw new RpcError(RPC.methodNotFound, "Method not found.");
    }
  };
}
