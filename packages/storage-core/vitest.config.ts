import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // CI runners stall workers for seconds at a time (CPU contention, AV scans);
    // a 5s default flakes tests that finish in milliseconds locally.
    testTimeout: 30_000,
  },
})
