/**
 * Reads Windows security descriptors as SDDL text, so the FFI layer only has
 * to hand back one string instead of walking ACL structs by offset (SR-15).
 * Anything this parser doesn't recognise makes the check fail closed.
 */

export interface Ace {
  type: string;
  flags: string;
  mask: number;
  sid: string;
}

export interface Sddl {
  owner: string | null;
  daclFlags: string;
  aces: Ace[];
}

const RIGHTS: Record<string, number> = {
  GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
  KA: 0xf003f, KR: 0x20019, KW: 0x20006, KX: 0x20019,
};

// Rights that let a holder change a file or its permissions.
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

// SDDL aliases that always name the same principal.
const FIXED_ALIASES: Record<string, string> = {
  WD: "S-1-1-0", CO: "S-1-3-0", CG: "S-1-3-1", OW: "S-1-3-4", NU: "S-1-5-2", IU: "S-1-5-4", SU: "S-1-5-6",
  AN: "S-1-5-7", ED: "S-1-5-9", PS: "S-1-5-10", AU: "S-1-5-11", RC: "S-1-5-12", SY: "S-1-5-18", LS: "S-1-5-19",
  NS: "S-1-5-20", BA: "S-1-5-32-544", BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547", AO: "S-1-5-32-548",
  SO: "S-1-5-32-549", PO: "S-1-5-32-550", BO: "S-1-5-32-551", RE: "S-1-5-32-552", RU: "S-1-5-32-554",
  RD: "S-1-5-32-555", NO: "S-1-5-32-556", MU: "S-1-5-32-558", LU: "S-1-5-32-559", IS: "S-1-5-32-568",
  CY: "S-1-5-32-569", ER: "S-1-5-32-573", WR: "S-1-5-33", AC: "S-1-15-2-1",
  LW: "S-1-16-4096", ME: "S-1-16-8192", HI: "S-1-16-12288", SI: "S-1-16-16384",
};

/**
 * Aliases such as LA (local Administrator), LG, DA or DU stand for a SID
 * relative to the machine's or the domain's own SID, which this text alone
 * can't tell. They stay unresolved, so one never matches the owner and counts
 * as an untrusted writer (fail closed). The FFI layer first writes the
 * current user's own alias back as its SID (withSelfSid).
 */
const UNRESOLVED = "unresolved:";

function principal(t: string): string {
  if (/^S-1-[0-9-]+$/.test(t)) return t;
  return FIXED_ALIASES[t] ?? UNRESOLVED + t;
}

/**
 * Replaces `token`, the alias Windows uses for the current user (LA for the
 * built-in Administrator), with the user's SID wherever it names a principal:
 * the owner and each ACE's trustee. `token` must come from Windows' own
 * converter for this user's SID, never from the descriptor being checked.
 */
export function withSelfSid(sddl: string, token: string, sid: string): string {
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error("bad SID");
  if (token === sid) return sddl;
  if (!/^[A-Z]{2}$/.test(token) || FIXED_ALIASES[token]) throw new Error("unexpected alias for the current user");
  return sddl
    .replace(new RegExp(`(^|[^A-Z])O:${token}(?=[A-Z]:|$)`), `$1O:${sid}`)
    .replace(new RegExp(`\\(([^()]*;)${token}\\)`, "g"), `($1${sid})`);
}

function parseMask(s: string): number {
  if (/^0x[0-9a-fA-F]{1,8}$/.test(s)) return Number.parseInt(s, 16);
  if (s.length === 0 || s.length % 2 !== 0) throw new Error("unreadable rights");
  let mask = 0;
  for (let i = 0; i < s.length; i += 2) {
    const r = RIGHTS[s.slice(i, i + 2)];
    if (r === undefined) throw new Error("unknown right");
    mask |= r;
  }
  return mask >>> 0;
}

export function parseSddl(text: string): Sddl {
  const owner = /O:([A-Z]{2}|S-1-[0-9-]+)/.exec(text)?.[1] ?? null;
  const d = /D:([A-Z]*)((?:\([^()]*\))*)/.exec(text);
  if (!d) throw new Error("no DACL");
  const aces: Ace[] = [];
  for (const m of d[2]!.matchAll(/\(([^()]*)\)/g)) {
    const parts = m[1]!.split(";");
    if (parts.length !== 6) throw new Error("unreadable ACE");
    const [type, flags, rights, , , sid] = parts as [string, string, string, string, string, string];
    aces.push({ type, flags, mask: parseMask(rights), sid: principal(sid) });
  }
  return { owner: owner ? principal(owner) : null, daclFlags: d[1]!, aces };
}

/** The channel pipe: a protected DACL that grants access to the owner and nobody else. */
export function isOwnerOnlyPipe(sddl: string, ownerSid: string): boolean {
  try {
    const sd = parseSddl(sddl);
    if (!sd.daclFlags.includes("P") || sd.aces.length === 0) return false;
    return sd.aces.every((a) => (a.type === "A" && a.sid === ownerSid && a.mask !== 0) || a.type === "D");
  } catch {
    return false;
  }
}

/**
 * The project paths file (SR-13): owned by the owner, and nobody but the
 * owner, SYSTEM and Administrators may write it.
 */
export function isOwnerWritableOnly(sddl: string, ownerSid: string): boolean {
  try {
    const sd = parseSddl(sddl);
    if (sd.owner !== ownerSid) return false;
    const trusted = new Set([ownerSid, "S-1-5-18", "S-1-5-32-544"]);
    for (const a of sd.aces) {
      if (a.flags.includes("IO")) continue;
      if (a.type === "D") continue;
      if (a.type !== "A") return false;
      if (!trusted.has(a.sid) && (a.mask & WRITE_MASK) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function ownerOnlyPipeSddl(ownerSid: string): string {
  if (!/^S-1-[0-9-]+$/.test(ownerSid)) throw new Error("bad SID");
  return `D:P(A;;GA;;;${ownerSid})`;
}
