import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Heavy randomized tests take under 1 s alone but can pass 5 s when every file runs in parallel on a
    // loaded Windows machine. A generous limit stops false failures; real hangs still fail.
    testTimeout: 30_000,
  },
});
