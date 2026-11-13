/**
 * The engine's only FFI module (SR-15). It is the only file that imports
 * koffi, it loads only the fixed OS libraries below by fixed name, and it
 * declares only the OS functions in FUNCTIONS. Nothing here takes a library
 * or function name from config or from a caller.
 *
 * Every call fails closed: a missing library, a non-success return, an
 * unexpected out-size or a malformed value throws FfiError, and callers turn
 * that into a refused connection, a refused start or a refused secret.
 *
 * Callers depend on the OsApi interface, never on koffi, so the rest of the
 * engine is unit-tested through a fake OsApi.
 */
import koffi from "koffi";
import { withSelfSid } from "./sddl";

export class FfiError extends Error {
  constructor(step: string) {
    super(`OS call failed: ${step}`);
    this.name = "FfiError";
  }
}

export interface PeerCred {
  uid: number;
  /** null where the OS doesn't report it. */
  pid: number | null;
}

/** An OS handle the Windows pipe code passes back in; opaque to callers. */
export type Handle = { readonly __handle: unique symbol };

export interface UnixApi {
  geteuid(): number;
  /** SO_PEERCRED (Linux) or getpeereid + LOCAL_PEERPID (macOS) on a connected Unix socket. */
  peerCred(fd: number): PeerCred;
  /** A live process's parent pid, or null if it has gone (macOS: proc_pidinfo; Linux reads /proc instead). */
  parentPid?(pid: number): number | null;
}

export interface WindowsApi {
  currentUserSid(): string;
  /** CreateNamedPipeW with the given SDDL as its security descriptor. */
  createPipe(name: string, sddl: string, first: boolean): Handle;
  /** The pipe's owner and DACL, read back from the kernel object, as SDDL with the current user named by SID. */
  handleSddl(h: Handle): string;
  /** Owner and DACL of a file, as SDDL with the current user named by SID. */
  fileSddl(path: string): string;
  /** Resolves when a client connects (ConnectNamedPipe on a worker thread). */
  connectPipe(h: Handle): Promise<void>;
  pipeClientPid(h: Handle): number;
  processUserSid(pid: number): string;
  /** A live process's parent pid from a Toolhelp snapshot, or null if it isn't running. */
  parentPid?(pid: number): number | null;
  /**
   * A process's creation sequence number, unique and increasing per boot, or null if it can't be
   * read. Unlike a creation time, setting the clock can't reorder it.
   */
  startOrder?(pid: number): number | null;
  /** Bytes waiting; throws once the client has gone. Never blocks. */
  pipeAvailable(h: Handle): number;
  readPipe(h: Handle, n: number): Buffer;
  writePipe(h: Handle, data: Buffer): void;
  closePipe(h: Handle): void;
}

/** Raw OS credential store calls. Names are built by secrets.ts, never here. */
export interface CredentialApi {
  read(service: string, account: string): Buffer | null;
  write(service: string, account: string, secret: Buffer): void;
  remove(service: string, account: string): boolean;
}

/** The fixed list of OS functions this module declares, per library. */
export const FUNCTIONS = {
  linux: {
    "libc.so.6": ["geteuid", "getsockopt"],
    "libsecret-1.so.0": ["secret_password_store_sync", "secret_password_lookup_sync", "secret_password_clear_sync", "secret_password_free"],
    "libglib-2.0.so.0": ["g_error_free"],
  },
  darwin: {
    "/usr/lib/libSystem.B.dylib": ["geteuid", "getpeereid", "getsockopt", "proc_pidinfo"],
    "/System/Library/Frameworks/Security.framework/Security": [
      "SecKeychainFindGenericPassword", "SecKeychainAddGenericPassword", "SecKeychainItemModifyAttributesAndData",
      "SecKeychainItemFreeContent", "SecKeychainItemDelete",
    ],
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation": ["CFRelease"],
  },
  win32: {
    "kernel32.dll": [
      "CreateNamedPipeW", "ConnectNamedPipe", "DisconnectNamedPipe", "GetNamedPipeClientProcessId", "PeekNamedPipe",
      "SetNamedPipeHandleState", "ReadFile", "WriteFile", "CloseHandle", "OpenProcess", "GetCurrentProcess", "LocalFree",
      "CreateToolhelp32Snapshot", "Process32FirstW", "Process32NextW",
    ],
    "ntdll.dll": ["NtQueryInformationProcess"],
    "advapi32.dll": [
      "OpenProcessToken", "GetTokenInformation", "ConvertSidToStringSidW", "GetSecurityInfo", "GetNamedSecurityInfoW",
      "ConvertStringSecurityDescriptorToSecurityDescriptorW", "ConvertSecurityDescriptorToStringSecurityDescriptorW",
      "CredReadW", "CredWriteW", "CredDeleteW", "CredFree",
    ],
  },
} as const;

type Fn = (...args: unknown[]) => unknown;
type AsyncFn = Fn & { async: (...args: unknown[]) => void };

function guard<T>(step: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof FfiError) throw e;
    throw new FfiError(step);
  }
}

function lib(platform: keyof typeof FUNCTIONS, name: string) {
  const allowed = (FUNCTIONS[platform] as Record<string, readonly string[]>)[name];
  if (!allowed) throw new FfiError(`library ${name} is not on the list`);
  const handle = guard(`load ${name}`, () => koffi.load(name));
  return (decl: string): AsyncFn => {
    const fname = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(decl.replace(/__stdcall/, ""))?.[1];
    if (!fname || !allowed.includes(fname)) throw new FfiError(`function ${fname} is not on the list`);
    return guard(`declare ${fname}`, () => handle.func(decl)) as unknown as AsyncFn;
  };
}

// ---------------------------------------------------------------------------
// Unix peers

const SOL_SOCKET_LINUX = 1;
const SO_PEERCRED = 17;
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 2;
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;

function linuxApi(): UnixApi {
  const f = lib("linux", "libc.so.6");
  const ucred = koffi.struct("factory_ucred", { pid: "int32", uid: "uint32", gid: "uint32" });
  const geteuid = f("uint32 geteuid()");
  const getsockopt = f("int getsockopt(int fd, int level, int name, _Out_ factory_ucred *val, _Inout_ uint32 *len)");
  const expected = koffi.sizeof(ucred);
  return {
    geteuid: () => guard("geteuid", () => geteuid() as number),
    peerCred(fd) {
      if (!Number.isInteger(fd) || fd < 0) throw new FfiError("no socket descriptor");
      const out: Array<{ pid: number; uid: number } | null> = [null];
      const len = [expected];
      const rc = guard("getsockopt", () => getsockopt(fd, SOL_SOCKET_LINUX, SO_PEERCRED, out, len));
      const cred = out[0];
      if (rc !== 0 || len[0] !== expected || !cred) throw new FfiError("getsockopt SO_PEERCRED");
      if (!Number.isInteger(cred.uid) || !Number.isInteger(cred.pid) || cred.pid <= 0) throw new FfiError("SO_PEERCRED values");
      return { uid: cred.uid, pid: cred.pid };
    },
  };
}

function darwinApi(): UnixApi {
  const f = lib("darwin", "/usr/lib/libSystem.B.dylib");
  const geteuid = f("uint32 geteuid()");
  const getpeereid = f("int getpeereid(int fd, _Out_ uint32 *uid, _Out_ uint32 *gid)");
  const getsockopt = f("int getsockopt(int fd, int level, int name, _Out_ int32 *val, _Inout_ uint32 *len)");
  // struct proc_bsdinfo starts with five uint32s: flags, status, xstatus, pid, ppid. Only that head is
  // declared; the call is given the full size so the kernel's copy stays inside the buffer.
  const bsd = koffi.struct("factory_proc_bsdinfo_head", {
    pbi_flags: "uint32", pbi_status: "uint32", pbi_xstatus: "uint32", pbi_pid: "uint32", pbi_ppid: "uint32",
    rest: koffi.array("uint8", PROC_BSDINFO_SIZE - 20),
  });
  const proc_pidinfo = f("int proc_pidinfo(int pid, int flavor, uint64 arg, _Out_ factory_proc_bsdinfo_head *buf, int size)");
  return {
    geteuid: () => guard("geteuid", () => geteuid() as number),
    parentPid(pid) {
      if (!Number.isInteger(pid) || pid <= 0) throw new FfiError("bad pid");
      const out: Array<{ pbi_pid: number; pbi_ppid: number } | null> = [null];
      const n = guard("proc_pidinfo", () => proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, koffi.sizeof(bsd)) as number);
      // 0 means the process is gone (ESRCH) or not visible; a short or mismatched answer is a failure.
      if (n === 0) return null;
      if (n !== PROC_BSDINFO_SIZE || !out[0] || out[0].pbi_pid !== pid) throw new FfiError("proc_pidinfo");
      return out[0].pbi_ppid;
    },
    peerCred(fd) {
      if (!Number.isInteger(fd) || fd < 0) throw new FfiError("no socket descriptor");
      const uid: Array<number | null> = [null];
      const gid: Array<number | null> = [null];
      if (guard("getpeereid", () => getpeereid(fd, uid, gid)) !== 0 || typeof uid[0] !== "number") {
        throw new FfiError("getpeereid");
      }
      const pid: Array<number | null> = [null];
      const len = [4];
      const rc = guard("getsockopt", () => getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, len));
      if (rc !== 0 || len[0] !== 4 || typeof pid[0] !== "number" || pid[0] <= 0) throw new FfiError("LOCAL_PEERPID");
      return { uid: uid[0], pid: pid[0] };
    },
  };
}

// ---------------------------------------------------------------------------
// Windows pipes and security descriptors

const PIPE_ACCESS_DUPLEX = 0x3;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x80000;
const PIPE_TYPE_BYTE = 0x0;
const PIPE_WAIT = 0x0;
const PIPE_NOWAIT = 0x1;
const PIPE_READMODE_BYTE = 0x0;
const CONNECT_POLL_MS = 20;
const PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const PIPE_UNLIMITED_INSTANCES = 255;
const PIPE_BUFFER = 1024 * 1024 + 4096;
const SDDL_REVISION_1 = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const SE_FILE_OBJECT = 1;
const SE_KERNEL_OBJECT = 6;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// PROCESSINFOCLASS ProcessSequenceNumber (Windows 10 and later): the kernel's per-boot process creation
// counter, as in System Informer's phnt headers (ntpsapi.h). Not in the SDK headers, so the Windows-only
// unit test checks it against this process and its parent.
const PROCESS_SEQUENCE_NUMBER = 92;
const TOKEN_QUERY = 0x8;
const TOKEN_USER_CLASS = 1;
const ERROR_PIPE_CONNECTED = 535;
const TH32CS_SNAPPROCESS = 0x2;

function windowsApi(): WindowsApi {
  const k = lib("win32", "kernel32.dll");
  const a = lib("win32", "advapi32.dll");
  koffi.alias("factory_DWORD", "uint32");
  const HANDLE = koffi.pointer("factory_HANDLE", koffi.opaque());
  koffi.struct("factory_SECURITY_ATTRIBUTES", { nLength: "uint32", lpSecurityDescriptor: "void *", bInheritHandle: "int32" });
  const PE32 = koffi.struct("factory_PROCESSENTRY32W", {
    dwSize: "uint32", cntUsage: "uint32", th32ProcessID: "uint32", th32DefaultHeapID: "uintptr_t", th32ModuleID: "uint32",
    cntThreads: "uint32", th32ParentProcessID: "uint32", pcPriClassBase: "int32", dwFlags: "uint32", szExeFile: koffi.array("uint16", 260),
  });
  void HANDLE;

  const CreateNamedPipeW = k("factory_HANDLE __stdcall CreateNamedPipeW(str16 name, uint32 openMode, uint32 pipeMode, uint32 maxInst, uint32 outBuf, uint32 inBuf, uint32 timeout, factory_SECURITY_ATTRIBUTES *sa)");
  const ConnectNamedPipe = k("int32 __stdcall ConnectNamedPipe(factory_HANDLE h, void *ovl)");
  const DisconnectNamedPipe = k("int32 __stdcall DisconnectNamedPipe(factory_HANDLE h)");
  const GetNamedPipeClientProcessId = k("int32 __stdcall GetNamedPipeClientProcessId(factory_HANDLE h, _Out_ uint32 *pid)");
  const PeekNamedPipe = k("int32 __stdcall PeekNamedPipe(factory_HANDLE h, void *buf, uint32 size, void *read, _Out_ uint32 *avail, void *left)");
  const ReadFile = k("int32 __stdcall ReadFile(factory_HANDLE h, _Out_ uint8 *buf, uint32 n, _Out_ uint32 *read, void *ovl)");
  const WriteFile = k("int32 __stdcall WriteFile(factory_HANDLE h, const uint8 *buf, uint32 n, _Out_ uint32 *written, void *ovl)");
  const SetNamedPipeHandleState = k("int32 __stdcall SetNamedPipeHandleState(factory_HANDLE h, uint32 *mode, void *maxCollect, void *timeout)");
  const CloseHandle = k("int32 __stdcall CloseHandle(factory_HANDLE h)");
  const OpenProcess = k("factory_HANDLE __stdcall OpenProcess(uint32 access, int32 inherit, uint32 pid)");
  const GetCurrentProcess = k("factory_HANDLE __stdcall GetCurrentProcess()");
  const LocalFree = k("void * __stdcall LocalFree(void *p)");
  const CreateToolhelp32Snapshot = k("factory_HANDLE __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)");
  const Process32FirstW = k("int32 __stdcall Process32FirstW(factory_HANDLE snap, _Inout_ factory_PROCESSENTRY32W *pe)");
  const nt = lib("win32", "ntdll.dll");
  const NtQueryInformationProcess = nt("int32 __stdcall NtQueryInformationProcess(factory_HANDLE p, int32 cls, _Out_ uint64 *info, uint32 len, _Out_ uint32 *ret)");
  const Process32NextW = k("int32 __stdcall Process32NextW(factory_HANDLE snap, _Inout_ factory_PROCESSENTRY32W *pe)");
  const OpenProcessToken = a("int32 __stdcall OpenProcessToken(factory_HANDLE p, uint32 access, _Out_ factory_HANDLE *token)");
  const GetTokenInformation = a("int32 __stdcall GetTokenInformation(factory_HANDLE token, int32 cls, void *buf, uint32 len, _Out_ uint32 *ret)");
  const ConvertSidToStringSidW = a("int32 __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **str)");
  const GetSecurityInfo = a("uint32 __stdcall GetSecurityInfo(factory_HANDLE h, int32 type, uint32 info, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **sd)");
  const GetNamedSecurityInfoW = a("uint32 __stdcall GetNamedSecurityInfoW(str16 path, int32 type, uint32 info, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **sd)");
  const StringToSd = a("int32 __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 sddl, uint32 rev, _Out_ void **sd, _Out_ uint32 *size)");
  const SdToString = a("int32 __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *sd, uint32 rev, uint32 info, _Out_ void **str, _Out_ uint32 *len)");

  const invalid = (h: unknown) => !h || koffi.address(h) === 0xffffffffffffffffn || koffi.address(h) === 0xffffffffn;

  function sdToSddl(sd: unknown, step: string): string {
    const str: unknown[] = [null];
    const len = [0];
    try {
      if (!SdToString(sd, SDDL_REVISION_1, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, str, len) || !str[0]) {
        throw new FfiError(step);
      }
      const s = koffi.decode.string16(str[0]);
      LocalFree(str[0]);
      return s;
    } finally {
      LocalFree(sd);
    }
  }

  function tokenUserSid(process: unknown): string {
    const token: unknown[] = [null];
    if (!OpenProcessToken(process, TOKEN_QUERY, token) || invalid(token[0])) throw new FfiError("OpenProcessToken");
    const buf = koffi.alloc("uint8", 512);
    try {
      const ret = [0];
      if (!GetTokenInformation(token[0], TOKEN_USER_CLASS, buf, 512, ret) || (ret[0] ?? 0) > 512) {
        throw new FfiError("GetTokenInformation");
      }
      const sidPtr = koffi.decode(buf, "void *");
      const str: unknown[] = [null];
      if (!sidPtr || !ConvertSidToStringSidW(sidPtr, str) || !str[0]) throw new FfiError("ConvertSidToStringSidW");
      const sid = koffi.decode.string16(str[0]);
      LocalFree(str[0]);
      if (!/^S-1-[0-9-]+$/.test(sid)) throw new FfiError("SID format");
      return sid;
    } finally {
      koffi.free(buf);
      CloseHandle(token[0]);
    }
  }

  let selfAlias: { sid: string; token: string } | null = null;
  /**
   * Windows writes some SIDs as aliases, such as LA for the built-in
   * Administrator. A round trip of the user's own SID through Windows'
   * converter shows which, if any, it uses; that one alias is written back
   * as the SID, and every other alias stays unresolved (sddl.ts).
   */
  function self(sddl: string): string {
    if (!selfAlias) {
      const sid = tokenUserSid(GetCurrentProcess());
      const sd: unknown[] = [null];
      const size = [0];
      if (!StringToSd(`O:${sid}D:`, SDDL_REVISION_1, sd, size) || !sd[0]) throw new FfiError("security descriptor");
      const m = /^O:([A-Z]{2}|S-1-[0-9-]+)D:/.exec(sdToSddl(sd[0], "owner SDDL"));
      if (!m) throw new FfiError("owner SDDL");
      selfAlias = { sid, token: m[1]! };
    }
    try {
      return withSelfSid(sddl, selfAlias.token, selfAlias.sid);
    } catch {
      throw new FfiError("current user alias");
    }
  }

  return {
    currentUserSid: () => guard("current user SID", () => tokenUserSid(GetCurrentProcess())),
    parentPid(pid) {
      if (!Number.isInteger(pid) || pid <= 0) throw new FfiError("bad pid");
      return guard("process snapshot", () => {
        const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (invalid(snap)) throw new FfiError("CreateToolhelp32Snapshot");
        try {
          // Windows checks dwSize against the struct it fills, so a layout mismatch fails the call.
          const pe: Array<Record<string, unknown>> = [{ dwSize: koffi.sizeof(PE32) }];
          // A snapshot always lists at least the System process, so an empty first answer is a failure.
          if (!Process32FirstW(snap, pe)) throw new FfiError("Process32FirstW");
          for (let ok = 1; ok; ok = Process32NextW(snap, pe) as number) {
            if (pe[0]!.th32ProcessID === pid) return pe[0]!.th32ParentProcessID as number;
          }
          return null;
        } finally {
          CloseHandle(snap);
        }
      });
    },

    createPipe(name, sddl, first) {
      return guard("CreateNamedPipeW", () => {
        const sd: unknown[] = [null];
        const size = [0];
        if (!StringToSd(sddl, SDDL_REVISION_1, sd, size) || !sd[0]) throw new FfiError("security descriptor");
        try {
          const sa = { nLength: koffi.sizeof("factory_SECURITY_ATTRIBUTES"), lpSecurityDescriptor: sd[0], bInheritHandle: 0 };
          const mode = PIPE_ACCESS_DUPLEX | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
          const h = CreateNamedPipeW(name, mode, PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER, PIPE_BUFFER, 0, sa);
          if (invalid(h)) throw new FfiError("CreateNamedPipeW");
          return h as Handle;
        } finally {
          LocalFree(sd[0]);
        }
      });
    },
    handleSddl(h) {
      return guard("GetSecurityInfo", () => {
        const o: unknown[] = [null], g: unknown[] = [null], d: unknown[] = [null], s: unknown[] = [null], sd: unknown[] = [null];
        if (GetSecurityInfo(h, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, o, g, d, s, sd) !== 0 || !sd[0]) {
          throw new FfiError("GetSecurityInfo");
        }
        return self(sdToSddl(sd[0], "pipe SDDL"));
      });
    },
    fileSddl(path) {
      return guard("GetNamedSecurityInfoW", () => {
        const o: unknown[] = [null], g: unknown[] = [null], d: unknown[] = [null], s: unknown[] = [null], sd: unknown[] = [null];
        if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, o, g, d, s, sd) !== 0 || !sd[0]) {
          throw new FfiError("GetNamedSecurityInfoW");
        }
        return self(sdToSddl(sd[0], "file SDDL"));
      });
    },
    connectPipe(h) {
      // A blocking ConnectNamedPipe would hold one of libuv's few pool threads per listener for as long as
      // it waits, starving the process's file I/O. Instead the instance listens in nonblocking mode and is
      // polled; Peek succeeds only once a client is connected (ERROR_PIPE_CONNECTED, which koffi can't
      // hand back reliably). Once connected the instance goes back to blocking mode for reads and writes.
      return new Promise((resolve, reject) => {
        const mode = (m: number) => {
          if (!SetNamedPipeHandleState(h, [m], null, null)) throw new FfiError("SetNamedPipeHandleState");
        };
        const tick = () => {
          try {
            ConnectNamedPipe(h, null);
            const avail = [0];
            if (PeekNamedPipe(h, null, 0, null, avail, null)) {
              mode(PIPE_READMODE_BYTE | PIPE_WAIT);
              return resolve();
            }
            // A client that came and went between two polls leaves the instance unusable (ERROR_NO_DATA)
            // until it is disconnected; a known client pid with a dead pipe is that case.
            const pid = [0];
            if (GetNamedPipeClientProcessId(h, pid) && pid[0]) DisconnectNamedPipe(h);
          } catch {
            return reject(new FfiError("ConnectNamedPipe"));
          }
          setTimeout(tick, CONNECT_POLL_MS);
        };
        try {
          mode(PIPE_READMODE_BYTE | PIPE_NOWAIT);
        } catch (e) {
          return reject(e);
        }
        tick();
      });
    },
    pipeClientPid(h) {
      return guard("GetNamedPipeClientProcessId", () => {
        const pid = [0];
        if (!GetNamedPipeClientProcessId(h, pid) || !pid[0]) throw new FfiError("GetNamedPipeClientProcessId");
        return pid[0];
      });
    },
    processUserSid(pid) {
      return guard("client SID", () => {
        const p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (invalid(p)) throw new FfiError("OpenProcess");
        try {
          return tokenUserSid(p);
        } finally {
          CloseHandle(p);
        }
      });
    },
    startOrder(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (invalid(p)) return null;
      try {
        const seq = [0n];
        if (NtQueryInformationProcess(p, PROCESS_SEQUENCE_NUMBER, seq, 8, [0]) !== 0) return null;
        const n = Number(seq[0]);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      } catch {
        return null;
      } finally {
        CloseHandle(p);
      }
    },
    pipeAvailable(h) {
      return guard("PeekNamedPipe", () => {
        const avail = [0];
        if (!PeekNamedPipe(h, null, 0, null, avail, null)) throw new FfiError("PeekNamedPipe");
        return avail[0] ?? 0;
      });
    },
    readPipe(h, n) {
      return guard("ReadFile", () => {
        const buf = Buffer.alloc(n);
        const read = [0];
        if (!ReadFile(h, buf, n, read, null) || (read[0] ?? 0) > n) throw new FfiError("ReadFile");
        return buf.subarray(0, read[0]);
      });
    },
    writePipe(h, data) {
      guard("WriteFile", () => {
        const written = [0];
        // No FlushFileBuffers: it waits until the client has read everything, which deadlocks a client in this process.
        if (!WriteFile(h, data, data.length, written, null) || written[0] !== data.length) throw new FfiError("WriteFile");
      });
    },
    closePipe(h) {
      try {
        DisconnectNamedPipe(h);
      } finally {
        CloseHandle(h);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Credential stores

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const ERROR_NOT_FOUND = 1168;

function windowsCredentials(): CredentialApi {
  const a = lib("win32", "advapi32.dll");
  koffi.struct("factory_FILETIME", { lo: "uint32", hi: "uint32" });
  const CRED = koffi.struct("factory_CREDENTIALW", {
    Flags: "uint32", Type: "uint32", TargetName: "str16", Comment: "str16", LastWritten: "factory_FILETIME",
    CredentialBlobSize: "uint32", CredentialBlob: "void *", Persist: "uint32", AttributeCount: "uint32",
    Attributes: "void *", TargetAlias: "str16", UserName: "str16",
  });
  const CredReadW = a("int32 __stdcall CredReadW(str16 target, uint32 type, uint32 flags, _Out_ void **cred)");
  const CredWriteW = a("int32 __stdcall CredWriteW(factory_CREDENTIALW *cred, uint32 flags)");
  const CredDeleteW = a("int32 __stdcall CredDeleteW(str16 target, uint32 type, uint32 flags)");
  const CredFree = a("void __stdcall CredFree(void *p)");
  const target = (service: string, account: string) => `${service}:${account}`;
  return {
    read(service, account) {
      return guard("CredReadW", () => {
        const out: unknown[] = [null];
        if (!CredReadW(target(service, account), CRED_TYPE_GENERIC, 0, out)) {
          // koffi can't return GetLastError reliably, so "missing" and "failed" both read as missing;
          // the caller then refuses to run without the secret, which is still closed.
          return null;
        }
        try {
          const cred = koffi.decode(out[0], CRED) as { CredentialBlobSize: number; CredentialBlob: unknown };
          if (cred.CredentialBlobSize > 64 * 1024) throw new FfiError("credential size");
          if (cred.CredentialBlobSize === 0) return Buffer.alloc(0);
          const bytes = koffi.decode(cred.CredentialBlob, "uint8", cred.CredentialBlobSize) as number[];
          return Buffer.from(bytes);
        } finally {
          CredFree(out[0]);
        }
      });
    },
    write(service, account, secret) {
      guard("CredWriteW", () => {
        if (secret.length > 2560) throw new FfiError("credential too large for the store");
        const blob = koffi.alloc("uint8", Math.max(1, secret.length));
        try {
          koffi.encode(blob, "uint8", Array.from(secret), secret.length);
          const cred = {
            Flags: 0, Type: CRED_TYPE_GENERIC, TargetName: target(service, account), Comment: null,
            LastWritten: { lo: 0, hi: 0 }, CredentialBlobSize: secret.length, CredentialBlob: blob,
            Persist: CRED_PERSIST_LOCAL_MACHINE, AttributeCount: 0, Attributes: null, TargetAlias: null, UserName: account,
          };
          if (!CredWriteW(cred, 0)) throw new FfiError("CredWriteW");
        } finally {
          koffi.encode(blob, "uint8", new Array(Math.max(1, secret.length)).fill(0), Math.max(1, secret.length));
          koffi.free(blob);
        }
      });
    },
    remove(service, account) {
      return guard("CredDeleteW", () => Boolean(CredDeleteW(target(service, account), CRED_TYPE_GENERIC, 0)));
    },
  };
}
void ERROR_NOT_FOUND;

const errSecItemNotFound = -25300;

function darwinCredentials(): CredentialApi {
  const s = lib("darwin", "/System/Library/Frameworks/Security.framework/Security");
  const cf = lib("darwin", "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const Find = s("int32 SecKeychainFindGenericPassword(void *kc, uint32 sl, const char *s, uint32 al, const char *a, _Out_ uint32 *pl, _Out_ void **pd, _Out_ void **item)");
  const Add = s("int32 SecKeychainAddGenericPassword(void *kc, uint32 sl, const char *s, uint32 al, const char *a, uint32 pl, const uint8 *pd, _Out_ void **item)");
  const Modify = s("int32 SecKeychainItemModifyAttributesAndData(void *item, void *attrs, uint32 len, const uint8 *data)");
  const FreeContent = s("int32 SecKeychainItemFreeContent(void *attrs, void *data)");
  const Delete = s("int32 SecKeychainItemDelete(void *item)");
  const CFRelease = cf("void CFRelease(void *p)");
  const blen = (x: string) => Buffer.byteLength(x, "utf8");

  function find(service: string, account: string, wantData: boolean) {
    const pl = [0];
    const pd: unknown[] = [null];
    const item: unknown[] = [null];
    const rc = Find(null, blen(service), service, blen(account), account, wantData ? pl : [0], wantData ? pd : [null], item) as number;
    if (rc === errSecItemNotFound) return null;
    if (rc !== 0 || !item[0]) throw new FfiError("SecKeychainFindGenericPassword");
    let data: Buffer | null = null;
    if (wantData) {
      if (!pd[0] || (pl[0] ?? 0) > 64 * 1024) throw new FfiError("keychain item size");
      data = Buffer.from(koffi.decode(pd[0], "uint8", pl[0] ?? 0) as number[]);
      FreeContent(null, pd[0]);
    }
    return { item: item[0], data };
  }

  return {
    read(service, account) {
      return guard("keychain read", () => {
        const found = find(service, account, true);
        if (!found) return null;
        CFRelease(found.item);
        return found.data;
      });
    },
    write(service, account, secret) {
      guard("keychain write", () => {
        const found = find(service, account, false);
        if (found) {
          try {
            if (Modify(found.item, null, secret.length, secret) !== 0) throw new FfiError("SecKeychainItemModifyAttributesAndData");
          } finally {
            CFRelease(found.item);
          }
          return;
        }
        const item: unknown[] = [null];
        if (Add(null, blen(service), service, blen(account), account, secret.length, secret, item) !== 0) {
          throw new FfiError("SecKeychainAddGenericPassword");
        }
        if (item[0]) CFRelease(item[0]);
      });
    },
    remove(service, account) {
      return guard("keychain delete", () => {
        const found = find(service, account, false);
        if (!found) return false;
        try {
          if (Delete(found.item) !== 0) throw new FfiError("SecKeychainItemDelete");
          return true;
        } finally {
          CFRelease(found.item);
        }
      });
    },
  };
}

function linuxCredentials(): CredentialApi {
  const s = lib("linux", "libsecret-1.so.0");
  const g = lib("linux", "libglib-2.0.so.0");
  const Attr = koffi.struct("factory_SecretSchemaAttribute", { name: "const char *", type: "int32" });
  koffi.struct("factory_SecretSchema", {
    name: "const char *", flags: "int32", attributes: koffi.array(Attr, 32), reserved: "int32",
    reserved1: "void *", reserved2: "void *", reserved3: "void *", reserved4: "void *",
    reserved5: "void *", reserved6: "void *", reserved7: "void *",
  });
  const store = s("int32 secret_password_store_sync(const factory_SecretSchema *schema, const char *collection, const char *label, const char *password, void *cancellable, _Out_ void **error, ...)");
  const lookup = s("void * secret_password_lookup_sync(const factory_SecretSchema *schema, void *cancellable, _Out_ void **error, ...)");
  const clear = s("int32 secret_password_clear_sync(const factory_SecretSchema *schema, void *cancellable, _Out_ void **error, ...)");
  const free = s("void secret_password_free(void *password)");
  const errorFree = g("void g_error_free(void *error)");

  const schema = (service: string) => ({
    name: service,
    flags: 0,
    attributes: [{ name: "account", type: 0 }, ...Array.from({ length: 31 }, () => ({ name: null, type: 0 }))],
    reserved: 0, reserved1: null, reserved2: null, reserved3: null, reserved4: null, reserved5: null, reserved6: null, reserved7: null,
  });
  const failed = (err: unknown[], step: string) => {
    if (err[0]) {
      errorFree(err[0]);
      throw new FfiError(step);
    }
  };

  return {
    read(service, account) {
      return guard("secret lookup", () => {
        const err: unknown[] = [null];
        const p = lookup(schema(service), null, err, "const char *", "account", "const char *", account, "const char *", null);
        failed(err, "secret_password_lookup_sync");
        if (!p) return null;
        try {
          return Buffer.from(koffi.decode.string(p), "utf8");
        } finally {
          free(p);
        }
      });
    },
    write(service, account, secret) {
      guard("secret store", () => {
        if (secret.includes(0)) throw new FfiError("secret holds a NUL byte");
        const err: unknown[] = [null];
        const ok = store(schema(service), "default", `${service} ${account}`, secret.toString("utf8"), null, err,
          "const char *", "account", "const char *", account, "const char *", null);
        failed(err, "secret_password_store_sync");
        if (!ok) throw new FfiError("secret_password_store_sync");
      });
    },
    remove(service, account) {
      return guard("secret clear", () => {
        const err: unknown[] = [null];
        const ok = clear(schema(service), null, err, "const char *", "account", "const char *", account, "const char *", null);
        failed(err, "secret_password_clear_sync");
        return Boolean(ok);
      });
    },
  };
}

// ---------------------------------------------------------------------------

export interface OsApi {
  platform: NodeJS.Platform;
  unix(): UnixApi;
  windows(): WindowsApi;
  credentials(): CredentialApi;
}

const cache = new Map<string, unknown>();
function once<T>(key: string, f: () => T): () => T {
  // koffi type names are process-wide, so each part is declared once per process.
  return () => {
    if (!cache.has(key)) cache.set(key, f());
    return cache.get(key) as T;
  };
}

/** Loads each OS part on first use, so a missing libsecret only stops the credential store. */
export function realOsApi(platform: NodeJS.Platform = process.platform): OsApi {
  const unsupported = (what: string) => () => {
    throw new FfiError(`${what} is not available on ${platform}`);
  };
  return {
    platform,
    unix: platform === "linux" ? once("linux", linuxApi) : platform === "darwin" ? once("darwin", darwinApi) : unsupported("Unix peer checks"),
    windows: platform === "win32" ? once("win32", windowsApi) : unsupported("Windows pipes"),
    credentials:
      platform === "linux" ? once("linux-cred", linuxCredentials)
        : platform === "darwin" ? once("darwin-cred", darwinCredentials)
          : platform === "win32" ? once("win32-cred", windowsCredentials)
            : unsupported("the credential store"),
  };
}
