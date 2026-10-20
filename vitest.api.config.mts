import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests need the real Next.js service started with pnpm dev.
    include: ["scripts/*.api.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
