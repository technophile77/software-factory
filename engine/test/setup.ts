import { afterAll, afterEach } from "vitest";
import { Git } from "../src/git";
import { removeTmpdirs } from "./helpers";

// Hundreds of sf-* folders otherwise pile up in the temp folder, run after run.
// Deleting hundreds of git trees is slow on Windows with a virus scanner.
afterAll(() => removeTmpdirs(), 120_000);
// F-014 readers keep their repo folder open on Windows until they exit.
afterEach(() => Git.closeAllReaders());
