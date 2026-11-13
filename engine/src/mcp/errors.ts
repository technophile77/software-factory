/** Stops a tool call before anything reaches the engine. */
export class Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "Refused";
  }
}

export interface DocumentRefusal {
  reason: string;
  lines?: number[];
  rule?: string;
}

/** The engine or the connection failed. */
export class ChannelFailure extends Error {
  /** The request left this process, so the engine may have acted on it. */
  sent: boolean;
  /** The engine answered with an error, so it saw and refused the call. */
  answered: boolean;
  startedAt?: string;
  refusal?: DocumentRefusal;
  /** Set on a reply the engine never answered, so the owner can retry with it (SR-12). */
  replyId?: string;

  constructor(readonly code: string | number, message: string, o: { sent?: boolean; answered?: boolean; startedAt?: string; refusal?: DocumentRefusal } = {}) {
    super(message);
    this.name = "ChannelFailure";
    this.sent = o.sent ?? false;
    this.answered = o.answered ?? false;
    if (o.startedAt) this.startedAt = o.startedAt;
    if (o.refusal) this.refusal = o.refusal;
  }

  setMessage(message: string): void {
    this.message = message;
  }
}

export function unreadable(): ChannelFailure {
  return new ChannelFailure("bad_response", "The engine sent an item the client can't read.", { sent: true });
}
