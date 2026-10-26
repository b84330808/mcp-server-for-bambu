import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The e2e tests start the built server over stdio, which can take several
    // seconds on a busy Windows machine (e.g. during an antivirus scan).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
