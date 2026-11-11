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

const ALIASES: Record<string, string> = { SY: "S-1-5-18", BA: "S-1-5-32-544" };

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
    aces.push({ type, flags, mask: parseMask(rights), sid: ALIASES[sid] ?? sid });
  }
  return { owner: owner ? ALIASES[owner] ?? owner : null, daclFlags: d[1]!, aces };
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
