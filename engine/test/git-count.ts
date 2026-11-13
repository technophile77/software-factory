import { appendFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { Git } from "../src/git";

// F-014 FR-7: with FACTORY_GIT_COUNTS set to a file, each test appends one
// JSON line with the git processes the engine started during it, so the
// suite's total can be measured from the repo:
//   node -e 'let t=0;for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n"))if(l)t+=JSON.parse(l).git;console.log(t)' counts.jsonl
const OUT = process.env.FACTORY_GIT_COUNTS;

if (OUT) {
  let start = 0;
  beforeEach(() => {
    start = Git.processes;
  });
  afterEach((ctx) => {
    if (ctx.task.result?.state === "skip") return;
    appendFileSync(OUT, JSON.stringify({ file: ctx.task.file.name, test: ctx.task.name, git: Git.processes - start }) + "\n");
  });
}
