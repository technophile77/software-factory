// What the fixtures need to do differently on Windows: programs the engine
// can start, the child environment, and file ownership and ACLs.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a Windows child needs from the environment to start networking and
 * find programs; empty elsewhere, so POSIX fixtures keep their minimal env. */
export const WINDOWS_ENV: Record<string, string> = Object.fromEntries(
  process.platform === "win32"
    ? ["SystemRoot", "ComSpec", "PATHEXT"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]))
    : [],
);

const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
let userSid: string | undefined;

/** On Windows, gives `file` the owner and ACL SR-13 asks for: owned by the
 * current user, writable only by them, SYSTEM and Administrators. Files made
 * in the temp folder otherwise inherit its ACL, and an elevated
 * administrator's files belong to BUILTIN\Administrators on Windows Server
 * (the CI runners). */
export function ownerOnly(file: string) {
  if (process.platform !== "win32") return;
  userSid ??= /S-1-[0-9-]+/.exec(execFileSync(join(SYSTEM32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }))?.[0];
  if (!userSid) throw new Error("whoami didn't report the current user's SID");
  const icacls = join(SYSTEM32, "icacls.exe");
  execFileSync(icacls, [file, "/setowner", `*${userSid}`], { stdio: "pipe" });
  execFileSync(icacls, [file, "/inheritance:r", "/grant:r", `*${userSid}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"], { stdio: "pipe" });
}

/** Grants `sids` write access to `file`: Windows's form of a group- or
 * world-writable file. */
export function grantWrite(file: string, sids: string[]) {
  execFileSync(join(SYSTEM32, "icacls.exe"), [file, ...sids.flatMap((s) => ["/grant", `*${s}:(W)`])], { stdio: "pipe" });
}

// The engine runs programs by absolute path with no shell, and Node refuses to
// spawn .cmd or .bat files without one, so on Windows a stand-in has to be a
// real .exe: this launcher. It runs `<prefix> <its own arguments>`, the
// prefix being the text of the .cmdline file beside it. The arguments are
// passed on as the raw command line, so they reach Node exactly as libuv
// quoted them. Node gets this process's standard handles, which are the
// engine's pipes.
const LAUNCHER_CS = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  static int Main() {
    string raw = Environment.CommandLine;
    int i = 0;
    if (raw.Length > 0 && raw[0] == '"') {
      i = raw.IndexOf('"', 1);
      i = i < 0 ? raw.Length : i + 1;
    } else {
      while (i < raw.Length && raw[i] != ' ' && raw[i] != '\t') i++;
    }
    string rest = raw.Substring(i).TrimStart(' ', '\t');
    string self = System.Reflection.Assembly.GetEntryAssembly().Location;
    string prefix = File.ReadAllText(Path.ChangeExtension(self, ".cmdline")).Trim();
    StringBuilder cmd = new StringBuilder(rest.Length > 0 ? prefix + " " + rest : prefix);
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 0x100;
    si.hStdInput = GetStdHandle(-10);
    si.hStdOutput = GetStdHandle(-11);
    si.hStdError = GetStdHandle(-12);
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("launcher: CreateProcess failed: " + Marshal.GetLastWin32Error());
      return 127;
    }
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    return unchecked((int)code);
  }
}
`;

let launcher: string | undefined;

/** The launcher, compiled once per source text and shared by every test
 * process. csc.exe ships with .NET Framework 4, which every supported
 * Windows has. */
function windowsLauncher(): string {
  if (launcher) return launcher;
  const dir = join(tmpdir(), "f007-launcher-" + createHash("sha256").update(LAUNCHER_CS).digest("hex").slice(0, 16));
  const exe = join(dir, "launcher.exe");
  if (!existsSync(exe)) {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const csc = ["Framework64", "Framework"]
      .map((f) => join(root, "Microsoft.NET", f, "v4.0.30319", "csc.exe"))
      .find((p) => existsSync(p));
    if (!csc) throw new Error("csc.exe (.NET Framework 4) not found; the Windows test stand-ins need it");
    mkdirSync(dir, { recursive: true });
    const src = join(dir, `launcher-${process.pid}-${randomBytes(4).toString("hex")}.cs`);
    const tmp = src.replace(/\.cs$/, ".exe");
    writeFileSync(src, LAUNCHER_CS);
    execFileSync(csc, ["/nologo", "/optimize", "/target:exe", `/out:${tmp}`, src], { stdio: "pipe" });
    try {
      renameSync(tmp, exe);
    } catch (e) {
      // Another test process won the race; its copy is the same program.
      if (!existsSync(exe)) throw e;
    }
    rmSync(src, { force: true });
    rmSync(tmp, { force: true });
  }
  launcher = exe;
  return exe;
}

/** Writes `script` as a program at `base` (`base.exe` on Windows) that runs
 * with this Node by absolute path, so it works even when PATH is cleared.
 * Returns the path to run. */
export function nodeProgram(base: string, script: string): string {
  if (process.platform !== "win32") {
    writeFileSync(base, `#!${process.execPath}\n${script}`);
    chmodSync(base, 0o755);
    return base;
  }
  writeFileSync(base + ".js", script);
  writeFileSync(base + ".cmdline", `"${process.execPath}" "${base}.js"`);
  // A copy, not a hard link: Windows can't delete any name of an image that
  // is running, so a link shared across test files would block cleanup.
  copyFileSync(windowsLauncher(), base + ".exe");
  return base + ".exe";
}

/**
 * Removes a test's folder. On Windows a file a running process holds can't
 * be deleted, and a test that timed out can leave its git or gitleaks
 * children running, so after a refusal this kills every process this test
 * process started (test files run one per process, so they are all this
 * test's) and tries again for a few seconds.
 */
export function removeTree(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return;
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
  killChildProcesses();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function killChildProcesses() {
  const ps = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
  let pids: number[] = [];
  try {
    const out = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}').ProcessId`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    pids = out.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
  } catch {
    return;
  }
  for (const pid of pids) {
    // /T takes the launcher's node and git's own children with it.
    try {
      execFileSync(join(SYSTEM32, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });
    } catch {
      // Already gone.
    }
  }
}

let symlinks: boolean | undefined;

/**
 * Whether this process may create symbolic links. Windows refuses them
 * (EPERM) without Developer Mode or elevation; tests that need a real
 * symlink skip there and say so.
 */
export function canSymlink(): boolean {
  if (symlinks !== undefined) return symlinks;
  const dir = mkdtempSync(join(tmpdir(), "f007-link-"));
  try {
    writeFileSync(join(dir, "t"), "");
    symlinkSync(join(dir, "t"), join(dir, "l"));
    symlinks = true;
  } catch {
    symlinks = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinks;
}

/** A symlink test's title, saying why it is skipped where links can't be made. */
export function needsSymlinks(title: string): string {
  return canSymlink() ? title : `${title} (skipped: needs symbolic links, which Windows refuses without Developer Mode or elevation)`;
}

/**
 * Links folder `at` to `target`: a symlink, or on Windows a junction, which
 * needs no privilege and which the engine must refuse just the same (Node's
 * lstat reports a junction as a link).
 */
export function linkDir(target: string, at: string) {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}
