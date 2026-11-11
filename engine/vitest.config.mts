import { defineConfig } from "vitest/config";

// Unit tests run with the defaults; the acceptance suite keeps its own config
// (longer timeouts, one process per file).
export default defineConfig({
  test: {
    projects: [
      { extends: false, test: { name: "unit", include: ["test/*.test.ts"] } },
      "test/acceptance/vitest.config.mts",
    ],
  },
});
