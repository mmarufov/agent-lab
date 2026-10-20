import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Research checkouts in .context are not part of this project's test suite.
    include: ["packages/*/test/**/*.test.ts", "my-agent/test/**/*.test.ts"],
    environment: "node",
  },
});
