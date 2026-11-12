import { afterAll } from "vitest";
import { removeTmpdirs } from "./helpers";

// Hundreds of sf-* folders otherwise pile up in the temp folder, run after run.
// Deleting hundreds of git trees is slow on Windows with a virus scanner.
afterAll(() => removeTmpdirs(), 120_000);
