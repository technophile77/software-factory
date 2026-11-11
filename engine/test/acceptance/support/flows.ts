import { expect } from "vitest";
import { rand, World } from "./world";
import type { RpcResponse } from "./rpc";

/** A running engine with one feature and an approved session. */
export async function interviewReady(w: World): Promise<{ feature: string; session: string }> {
  await w.boot();
  const feature = await w.startFeature();
  const session = await w.approvedSession(feature);
  await w.tools(feature);
  return { feature, session };
}

/** The analyst asks; the client fetches the item with interview.next. */
export async function askAndFetch(w: World, feature: string, session: string, args: Record<string, unknown> = {}) {
  const asked = await w.ask(feature, args);
  const next = await w.ok("interview.next", { session });
  expect(next.item?.id).toBe(asked.id);
  return next.item;
}

/** One full exchange that makes the engine write and commit a transcript entry. */
export async function answerOne(w: World, text = `Answer ${rand(6)}`) {
  const { feature, session } = await interviewReady(w);
  const item = await askAndFetch(w, feature, session);
  const r = await w.reply(session, item, "answer", text);
  return { feature, session, item, reply: r, text };
}

export function errorCode(r: RpcResponse): number | undefined {
  return r.error?.code;
}

export function expectRpcError(r: RpcResponse, code: number) {
  expect(r.result, `expected error ${code}, got result ${JSON.stringify(r.result)}`).toBeUndefined();
  expect(r.error?.code, JSON.stringify(r.error)).toBe(code);
  expect(typeof r.error?.message).toBe("string");
}

/** ISO 8601 in UTC, as `busy` carries it. */
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const SESSION_TOKEN = /^[0-9a-f]{32}$/i;
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
