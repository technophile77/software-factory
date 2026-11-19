import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";
import { FACTORY_LEASE_SCHEMA, type FactoryLease, factoryLease } from "../schemas/factory-lease";

/** F-023 FR-7: the lease on a project's factory/state, at its top as `.factory/lease.json`. */
export const LEASE_PATH = "lease.json";
/** FR-7 (d): renewed this often while the project runs. */
export const LEASE_RENEW_MS = 10 * 60_000;
/** FR-7 (f): a lease whose commit hasn't changed this long, by this factory's own clock, is stale. */
export const LEASE_STALE_MS = 30 * 60_000;
/** FR-7 (g): a GitHub write needs a lease check no older than this. */
export const LEASE_CHECK_MS = 60_000;

/** FR-7: random, made once per engine folder, and nothing about the PC, user or paths (SR-3). */
export function factoryId(home: string): string {
  ensureOwnerDir(home);
  const file = path.join(home, "factory-id");
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  } catch {
    // Not made yet.
  }
  const id = crypto.randomBytes(16).toString("hex");
  writeFileAtomic(file, `${id}\n`);
  return id;
}

/** The lease a factory/state commit holds; null when it holds none or one that doesn't parse (treated as none). */
export function parseLease(raw: Buffer | null): FactoryLease | null {
  if (!raw) return null;
  try {
    return factoryLease.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    return null;
  }
}

export function leaseText(factory: string, started: string, renewed: string): string {
  const l: FactoryLease = { schema: FACTORY_LEASE_SCHEMA, factory, started, renewed };
  return `${JSON.stringify(l, null, 2)}\n`;
}

/**
 * FR-7 (f): when this factory first saw each project's lease blob. Staleness
 * is judged only from that, never from the times written in the lease, so a
 * wrong clock on the other PC can't make its lease look old or new.
 */
export class LeaseSightings {
  private seen = new Map<string, { blob: string; at: number }>();

  /** How long, by this clock, the lease has been unchanged. */
  unchangedFor(project: string, blob: string, now: number): number {
    const s = this.seen.get(project);
    if (!s || s.blob !== blob) {
      this.seen.set(project, { blob, at: now });
      return 0;
    }
    return now - s.at;
  }
}
