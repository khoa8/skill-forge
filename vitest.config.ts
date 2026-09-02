import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // API tests bind port 0; give the suite a little headroom.
    testTimeout: 30_000,
  },
});
