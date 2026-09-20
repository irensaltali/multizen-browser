/**
 * Environment bindings for the MultiZen sync coordination Worker.
 *
 * No R2 binding is declared here by design: the coordination backend is
 * authoritative for ownership / leases / revision metadata only. Object
 * storage (Kopia repository in R2/S3) is handled out-of-band by the desktop
 * client and is intentionally not reachable from this Worker.
 */
export interface Env {
  /** SQLite-backed Durable Object namespace, one instance per profile id. */
  PROFILE_COORDINATOR: DurableObjectNamespace;

  /** Cloudflare Access JWT issuer, e.g. https://<team>.cloudflareaccess.com */
  CF_ACCESS_JWT_ISSUER: string;
  /** Cloudflare Access application audience (AUD) tag. */
  CF_ACCESS_JWT_AUDIENCE: string;

  /** Default lease TTL in milliseconds (string in wrangler vars). */
  DEFAULT_LEASE_TTL_MS?: string;
  /** Recommended client renewal interval in milliseconds (string in wrangler vars). */
  RECOMMENDED_RENEWAL_MS?: string;

  /**
   * Test-only escape hatch. The auth bypass engages ONLY when this is the
   * literal string "1" AND CF_ACCESS_JWT_ISSUER is the test-only sentinel
   * issuer (see auth.ts:bypassEnabled). Both are injected exclusively by
   * vitest.config.ts; the deployed wrangler config sets neither to a test
   * value, so production always runs full Access JWT verification. Never set
   * this in production.
   */
  TEST_AUTH_BYPASS?: string;
}
