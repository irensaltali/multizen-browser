import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env.js";
import { ApiError, ErrorCode } from "./errors.js";

/**
 * Cloudflare Access JWT validation.
 *
 * Access places a signed assertion in the `Cf-Access-Jwt-Assertion` header (and
 * as the `CF_Authorization` cookie). We verify it against the team's remote
 * JWKS using `jose`, pinning issuer and audience from env configuration.
 *
 * For service tokens, Access embeds the token's client id as `common_name` and
 * uses `sub` for the subject; we bind both into the request Identity so
 * downstream handlers can attribute writes.
 */

export interface Identity {
  /** JWT `sub` claim — stable principal id. */
  subject: string;
  /** Service-token common name (client id) when present. */
  commonName: string | null;
  /** End-user email when present (interactive Access sessions). */
  email: string | null;
  /** True when produced by the test bypass rather than a verified JWT. */
  synthetic: boolean;
}

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * Cache the remote JWKS per issuer for the lifetime of the isolate. jose's
 * remote set performs its own caching/rotation, so we only key by issuer URL.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(issuer);
  if (existing) return existing;
  const url = new URL("/cdn-cgi/access/certs", issuer);
  const jwks = createRemoteJWKSet(url);
  jwksCache.set(issuer, jwks);
  return jwks;
}

/**
 * Test-only auth bypass. Defense-in-depth: honored ONLY when BOTH
 *   - TEST_AUTH_BYPASS is exactly "1", AND
 *   - CF_ACCESS_JWT_ISSUER is the test-only sentinel issuer
 *     (`https://test.cloudflareaccess.com`, injected solely by vitest.config.ts).
 * A production Worker points CF_ACCESS_JWT_ISSUER at the real team issuer, so
 * even if TEST_AUTH_BYPASS were ever set as a Worker var/secret by mistake, the
 * bypass would NOT engage and full Access JWT verification still runs.
 */
const TEST_ISSUER = "https://test.cloudflareaccess.com";

export function bypassEnabled(env: Env): boolean {
  return env.TEST_AUTH_BYPASS === "1" && env.CF_ACCESS_JWT_ISSUER?.trim() === TEST_ISSUER;
}

interface AccessClaims extends JWTPayload {
  common_name?: string;
  email?: string;
  identity_nonce?: string;
}

export async function authenticate(request: Request, env: Env): Promise<Identity> {
  if (bypassEnabled(env)) {
    // Synthetic identity for tests. Callers may override subject/common_name via
    // headers so multiple logical devices can be simulated in one test env.
    return {
      subject: request.headers.get("x-test-subject") ?? "test-subject",
      commonName: request.headers.get("x-test-common-name") ?? "test-service-token",
      email: request.headers.get("x-test-email"),
      synthetic: true,
    };
  }

  const issuer = env.CF_ACCESS_JWT_ISSUER?.trim();
  const audience = env.CF_ACCESS_JWT_AUDIENCE?.trim();
  if (!issuer || !audience) {
    throw new ApiError(ErrorCode.INTERNAL, "Access issuer/audience not configured");
  }

  const token = extractToken(request);
  if (!token) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, "missing Cloudflare Access assertion");
  }

  let payload: AccessClaims;
  try {
    const result = await jwtVerify<AccessClaims>(token, getJwks(issuer), {
      issuer,
      audience,
    });
    payload = result.payload;
  } catch {
    throw new ApiError(ErrorCode.UNAUTHORIZED, "invalid Cloudflare Access assertion");
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, "Access assertion missing subject");
  }

  return {
    subject: payload.sub,
    commonName: typeof payload.common_name === "string" ? payload.common_name : null,
    email: typeof payload.email === "string" ? payload.email : null,
    synthetic: false,
  };
}

function extractToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_JWT_HEADER);
  if (header && header.length > 0) return header;

  // Fall back to the CF_Authorization cookie.
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "CF_Authorization" && rest.length > 0) {
      return rest.join("=");
    }
  }
  return null;
}
