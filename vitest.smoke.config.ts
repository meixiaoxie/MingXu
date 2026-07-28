import { defineConfig } from "vitest/config";

// Smoke tests validate the packed artifact path and intentionally run outside the
// default fast suite so local loops and CI can keep tarball installation separate.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/package-smoke.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
