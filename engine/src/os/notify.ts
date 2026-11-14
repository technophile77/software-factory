import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../log";
import { Children, baseEnv, runFixed } from "../proc";

export type Notify = (title: string, text: string) => void;

/**
 * A notifier that a stopping engine can end, so it leaves no child running in
 * its folder: `stop` ends the notifications still running and resolves once
 * they have exited. `settled` only waits for them.
 */
export type OsNotify = Notify & { settled(): Promise<void>; stop(): Promise<void> };

/** The program that shows one notification, or null where there is none. */
export type NotifyProgram = (title: string, text: string) => { bin: string; args: string[] } | null;

/**
 * Windows toast through Windows PowerShell's own app id, so nothing is
 * installed (F-011 FR-13). The title and text arrive as environment
 * variables and are XML-escaped in the script; nothing from them is run.
 */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]",
  "$t=[Security.SecurityElement]::Escape($env:FACTORY_NOTE_TITLE)",
  "$b=[Security.SecurityElement]::Escape($env:FACTORY_NOTE_TEXT)",
  "$x=New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$x.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>\")",
  "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join(";");

const MAX = 200;
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, MAX);

/**
 * An OS notification on the owner's PC, best effort: a failure is logged
 * and never stops the engine. Linux needs notify-send; without it the
 * engine log is the notice.
 */
export function osNotifier(o: { platform: NodeJS.Platform; children: Children; log: Logger; cwd: string; program?: NotifyProgram }): OsNotify {
  const running = new Set<Promise<void>>();
  const ending = new AbortController();
  const program = o.program ?? osProgram(o.platform);
  const notify = (title: string, text: string): void => {
    if (ending.signal.aborted) return;
    const env = { ...baseEnv(), FACTORY_NOTE_TITLE: clean(title), FACTORY_NOTE_TEXT: clean(text) };
    const p = program(clean(title), clean(text));
    if (!p) return;
    const shown = runFixed(p.bin, p.args, { cwd: o.cwd, env, timeoutMs: 10_000, maxStdout: 4096, signal: ending.signal }, o.children)
      .then((r) => {
        if (ending.signal.aborted && r.code === null) o.log.info("OS notification not shown: the engine stopped first.");
        else if (r.code !== 0) o.log.info(`OS notification not shown (exit ${r.code}).`);
      })
      .catch(() => o.log.info("OS notification not shown."))
      .finally(() => running.delete(shown));
    running.add(shown);
  };
  const settled = async () => void (await Promise.all([...running]));
  // A notification is best effort, and one that hangs (a Windows toast with no desktop to show on runs to its
  // 10-second limit) must not hold the engine's stop that long.
  const stop = async () => {
    ending.abort();
    await settled();
  };
  return Object.assign(notify, { settled, stop });
}

function osProgram(platform: NodeJS.Platform): NotifyProgram {
  return (title, text) => {
    if (platform === "win32") {
      const bin = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      return { bin, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT] };
    }
    if (platform === "darwin") {
      return { bin: "/usr/bin/osascript", args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, text] };
    }
    const bin = ["/usr/bin/notify-send", "/bin/notify-send"].find((p) => fs.existsSync(p));
    return bin ? { bin, args: ["--", title, text] } : null;
  };
}
