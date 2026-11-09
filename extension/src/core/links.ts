import * as fs from "node:fs";
import * as path from "node:path";
import { isWithin } from "./git";
import type { ItemLink, ResolvedLink } from "./types";

export function resolveLink(repoDir: string, link: ItemLink): ResolvedLink {
  const ref = link.ref.trim();

  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) {
    // A URL. Only https opens; file:, javascript:, command: and the rest could
    // reach outside the repo or run code (SR-3).
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return { kind: "refused", reason: "Not a valid URL." };
    }
    if (url.protocol !== "https:") return { kind: "refused", reason: `Only https links open (${url.protocol}).` };
    return { kind: "url", url: url.toString() };
  }

  if (path.isAbsolute(ref) || /^[a-z]:[\\/]/i.test(ref)) {
    return { kind: "refused", reason: "Absolute paths are not allowed." };
  }

  const lexical = path.resolve(repoDir, ref);
  if (!isWithin(path.resolve(repoDir), lexical)) {
    return { kind: "refused", reason: "Link points outside the repository." };
  }
  // Also compare real paths, so a symlink inside the repo can't lead out of it.
  const real = realpath(lexical);
  if (real && !isWithin(realpath(repoDir) ?? path.resolve(repoDir), real)) {
    return { kind: "refused", reason: "Link points outside the repository." };
  }
  return { kind: "file", absPath: real ?? lexical };
}

function realpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}
