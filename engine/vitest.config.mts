import { defineConfig } from "vitest/config";

// Unit tests run with the defaults; the acceptance suite keeps its own config
// (longer timeouts, one process per file).
export default defineConfig({
  test: {
    projects: [
      // Some unit tests run real git over loopback HTTP, which hosted macOS and Windows runners make slow.
      { extends: false, test: { name: "unit", include: ["test/*.test.ts"], testTimeout: 30_000 } },
      "test/acceptance/vitest.config.mts",
    ],
  },
});
