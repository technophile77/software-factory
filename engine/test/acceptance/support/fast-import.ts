// Builds fixture repos with one `git fast-import` run instead of a dozen
// git commands each (H-0132). Starting a process is most of a test's cost
// on Windows and macOS runners, so fewer starts make every test faster.

/** One commit for {@link fastImportStream}. */
export interface FixtureCommit {
  /** The branch the commit lands on, e.g. "refs/heads/main". */
  ref: string;
  message: string;
  /** The whole tree, path to text; every file is a regular 100644 blob. */
  files: Readonly<Record<string, string>>;
  /** Commit time in seconds since the epoch. */
  time: number;
  /** Extra refs that point at this commit, e.g. a lightweight tag. */
  alsoAt?: readonly string[];
}

/** Who the fixture commits are by, as the fixtures' git() sets it. */
export const FIXTURE_IDENT = "Fixture <fixture@example.invalid>";

/**
 * The fast-import input for a set of root commits, one per ref, with no
 * parents, as `git init` + `add` + `commit` (+ `checkout --orphan`) would make.
 *
 * @param commits Commits in order; each starts its own history.
 * @returns The stream for `git fast-import` on stdin.
 * @example
 * fastImportStream([{ ref: "refs/heads/main", message: "initial", files: { "README.md": "# app\n" }, time: 1700000000 }])
 * @see FixtureCommit
 */
export function fastImportStream(commits: readonly FixtureCommit[]): Buffer {
  const parts: Buffer[] = [];
  const text = (s: string) => parts.push(Buffer.from(s, "utf8"));
  const data = (body: string) => {
    const b = Buffer.from(body, "utf8");
    text(`data ${b.length}\n`);
    parts.push(b);
    text("\n");
  };
  commits.forEach((c, i) => {
    const mark = i + 1;
    // A reset first, so a ref named twice never chains onto an earlier commit.
    text(`reset ${c.ref}\ncommit ${c.ref}\nmark :${mark}\n`);
    text(`author ${FIXTURE_IDENT} ${c.time} +0000\ncommitter ${FIXTURE_IDENT} ${c.time} +0000\n`);
    data(c.message.endsWith("\n") ? c.message : `${c.message}\n`);
    for (const path of Object.keys(c.files).sort()) {
      if (/[\n"]/.test(path) || path.startsWith("/")) throw new Error(`fixture path ${JSON.stringify(path)} can't go in a fast-import stream`);
      text(`M 100644 inline ${path}\n`);
      data(c.files[path]!);
    }
    for (const ref of c.alsoAt ?? []) text(`reset ${ref}\nfrom :${mark}\n\n`);
  });
  text("done\n");
  return Buffer.concat(parts);
}
