import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Pool v0.22.0 uses the plugin API (formerly `defineWorkersConfig` +
// `test.poolOptions.workers`). The argument to `cloudflareTest` is the old
// `workers` options object.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Point the pool at the same wrangler config the deploy uses so the
      // SQLite-backed Durable Object migration is applied in-test.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only bindings. TEST_AUTH_BYPASS is honored ONLY here; the
        // deployed wrangler config never sets it, so production always runs
        // full Cloudflare Access JWT verification.
        bindings: {
          TEST_AUTH_BYPASS: "1",
          CF_ACCESS_JWT_ISSUER: "https://test.cloudflareaccess.com",
          CF_ACCESS_JWT_AUDIENCE: "test-audience",
        },
      },
    }),
  ],
});
