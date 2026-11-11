import { afterAll } from "vitest";
import { removeTmpdirs } from "./helpers";

// Hundreds of sf-* folders otherwise pile up in the temp folder, run after run.
afterAll(() => removeTmpdirs());
