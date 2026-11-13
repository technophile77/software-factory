import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../log";
import { Children, baseEnv, runFixed } from "../proc";

export type Notify = (title: string, text: string) => void;

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
export function osNotifier(o: { platform: NodeJS.Platform; children: Children; log: Logger; cwd: string }): Notify {
  return (title, text) => {
    const env = { ...baseEnv(), FACTORY_NOTE_TITLE: clean(title), FACTORY_NOTE_TEXT: clean(text) };
    let bin: string;
    let args: string[];
    if (o.platform === "win32") {
      bin = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT];
    } else if (o.platform === "darwin") {
      bin = "/usr/bin/osascript";
      args = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", clean(title), clean(text)];
    } else {
      bin = ["/usr/bin/notify-send", "/bin/notify-send"].find((p) => fs.existsSync(p)) ?? "";
      args = ["--", clean(title), clean(text)];
    }
    if (!bin) return;
    runFixed(bin, args, { cwd: o.cwd, env, timeoutMs: 10_000, maxStdout: 4096 }, o.children)
      .then((r) => {
        if (r.code !== 0) o.log.info(`OS notification not shown (exit ${r.code}).`);
      })
      .catch(() => o.log.info("OS notification not shown."));
  };
}
