import { describe, it, expect } from "vitest";
import { bypassEnabled } from "../src/auth.js";
import type { Env } from "../src/env.js";

/**
 * P2 hardening: the test-only auth bypass must engage ONLY when BOTH
 * TEST_AUTH_BYPASS === "1" AND CF_ACCESS_JWT_ISSUER is the test sentinel issuer.
 * A production issuer must NOT be bypassable even if TEST_AUTH_BYPASS leaks in.
 */
function env(patch: Partial<Env>): Env {
  return {
    PROFILE_COORDINATOR: {} as Env["PROFILE_COORDINATOR"],
    CF_ACCESS_JWT_ISSUER: "https://team.cloudflareaccess.com",
    CF_ACCESS_JWT_AUDIENCE: "aud",
    ...patch,
  };
}

describe("bypassEnabled (P2 defense-in-depth)", () => {
  it("engages only with both the flag AND the test-only issuer sentinel", () => {
    expect(
      bypassEnabled(
        env({ TEST_AUTH_BYPASS: "1", CF_ACCESS_JWT_ISSUER: "https://test.cloudflareaccess.com" }),
      ),
    ).toBe(true);
  });

  it("does NOT engage with the flag but a production issuer", () => {
    expect(
      bypassEnabled(
        env({ TEST_AUTH_BYPASS: "1", CF_ACCESS_JWT_ISSUER: "https://team.cloudflareaccess.com" }),
      ),
    ).toBe(false);
  });

  it("does NOT engage with the test issuer but no flag", () => {
    expect(
      bypassEnabled(env({ CF_ACCESS_JWT_ISSUER: "https://test.cloudflareaccess.com" })),
    ).toBe(false);
  });

  it("does NOT engage for a non-'1' flag value even with the test issuer", () => {
    expect(
      bypassEnabled(
        env({ TEST_AUTH_BYPASS: "true", CF_ACCESS_JWT_ISSUER: "https://test.cloudflareaccess.com" }),
      ),
    ).toBe(false);
  });
});
