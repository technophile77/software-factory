import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Run from engine/: `npx vitest run --config test/acceptance/vitest.config.mts`.
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each test builds its own world in a temp dir. Files run in separate
    // processes; tests within a file run one after another.
    pool: "forks",
  },
});
