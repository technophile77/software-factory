import * as fs from "node:fs";
import * as path from "node:path";
import { Clock, iso } from "./clock";
import { ensureOwnerDir } from "./fsutil";

/**
 * Logs live in an owner-only folder outside every repo (0700, files 0600).
 * Callers pass ids, names and reasons only: never tokens, credentials,
 * device codes, owner reply text or analyst text (SR-1, sensitive data).
 */
export const LOG_RETENTION_DAYS = 30;

export interface ActionRecord {
  agent: string;
  action: string;
  target: string;
  approval_id?: string | null;
  outcome?: string;
}

export interface Logger {
  info(message: string): void;
  /** Also shown to the owner on the engine's console. */
  warn(message: string): void;
  /** SR-4: every external action. */
  action(rec: ActionRecord): void;
}

export class FileLogger implements Logger {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock,
    private readonly console: (line: string) => void = (l) => process.stderr.write(l + "\n"),
  ) {
    ensureOwnerDir(dir);
    this.prune();
  }

  // An info or warn line that can't be written (log folder gone, disk full)
  // mustn't stop the engine mid-shutdown; action records still fail closed (SR-4).
  info(message: string): void {
    if (!this.tryWrite({ level: "info", message })) this.console(`factory-engine: ${message}`);
  }

  warn(message: string): void {
    this.tryWrite({ level: "warn", message });
    this.console(`factory-engine: ${message}`);
  }

  action(rec: ActionRecord): void {
    this.write({ level: "action", ...rec, approval_id: rec.approval_id ?? null });
  }

  private tryWrite(rec: Record<string, unknown>): boolean {
    try {
      this.write(rec);
      return true;
    } catch {
      return false;
    }
  }

  private write(rec: Record<string, unknown>): void {
    const now = this.clock.now();
    const file = path.join(this.dir, `${iso(now).slice(0, 10)}.log`);
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ at: iso(now), ...rec }) + "\n");
    } finally {
      fs.closeSync(fd);
    }
  }

  private prune(): void {
    const cutoff = iso(this.clock.now() - LOG_RETENTION_DAYS * 86400_000).slice(0, 10);
    for (const name of fs.readdirSync(this.dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m && m[1]! < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

export class MemoryLogger implements Logger {
  readonly lines: Array<Record<string, unknown>> = [];
  info(message: string): void {
    this.lines.push({ level: "info", message });
  }
  warn(message: string): void {
    this.lines.push({ level: "warn", message });
  }
  action(rec: ActionRecord): void {
    this.lines.push({ level: "action", ...rec });
  }
  text(): string {
    return this.lines.map((l) => JSON.stringify(l)).join("\n");
  }
}
