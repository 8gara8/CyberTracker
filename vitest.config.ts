import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    // No test touches the network (SPEC §8.1, ruling R56): fetch reaches only localhost, git only file://.
    setupFiles: ["tests/setup/offline.ts"],
  },
});
