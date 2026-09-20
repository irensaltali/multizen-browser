/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { validateProfileId } from "../src/validation.js";
import { ApiError } from "../src/errors.js";

/**
 * Path-traversal hardening for profile ids (desktop pairing).
 *
 * A profile id is used verbatim as a single path segment (Kopia snapshot /
 * R2 key layout) and as the Durable Object name, so it MUST be a safe,
 * non-traversing single segment.
 *
 * Defense-in-depth, verified end-to-end below:
 *
 *  1. Unit layer — `validateProfileId` rejects every traversal token it is
 *     handed: `.`, `..`, `...`, path separators, control/whitespace, and any
 *     char outside the conservative charset, while still accepting UUIDs and
 *     allowed opaque ids.
 *
 *  2. Worker layer — a traversal-like id in the URL is ALWAYS rejected before
 *     it can reach or create a coordinator. The WHATWG URL parser collapses
 *     genuine `.`/`..` segments (raw or `%2e`-encoded) to a different path, so
 *     those surface as a route miss (NOT_FOUND / METHOD_NOT_ALLOWED); anything
 *     that survives normalization and still decodes to an unsafe segment is
 *     rejected by `validateProfileId` with VALIDATION_FAILED. In no case is a
 *     lease minted or coordinator state returned.
 */

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`https://backend.test${path}`, { method, headers, body: bodyInit });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const opId = (() => {
  let n = 0;
  return () => `op-${Date.now()}-${n++}-abcdef`;
})();

function rejectCode(value: unknown): string | null {
  try {
    validateProfileId(value);
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.code : "THREW";
  }
}

// ---------------------------------------------------------------------------
// Unit: validateProfileId decision surface
// ---------------------------------------------------------------------------
describe("validateProfileId (unit)", () => {
  const rejected: Array<[string, unknown]> = [
    ["single dot", "."],
    ["double dot", ".."],
    ["triple dot", "..."],
    ["many dots", "........"],
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["leading traversal", "../etc/passwd"],
    ["null byte", "profile\u0000"],
    ["newline", "profile\nid"],
    ["carriage return", "profile\rid"],
    ["tab", "profile\tid"],
    ["space", "profile id"],
    ["tilde", "~"],
    ["percent (raw)", "%2e%2e"],
    ["empty string", ""],
    ["too long (129)", "a".repeat(129)],
    ["non-string", 123],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name} with VALIDATION_FAILED`, () => {
      expect(rejectCode(value)).toBe("VALIDATION_FAILED");
    });
  }

  const accepted: Array<[string, string]> = [
    ["a UUID", crypto.randomUUID()],
    ["a prefixed UUID", `profile-${crypto.randomUUID()}`],
    ["opaque with dots/colons/dashes/underscores", "team_a.profile-01:v2"],
    ["a single non-dot char", "a"],
    ["a name containing dots but not dot-only", "a..b"],
    ["max length 128", "a".repeat(128)],
  ];

  for (const [name, value] of accepted) {
    it(`accepts ${name}`, () => {
      expect(validateProfileId(value)).toBe(value);
    });
  }
});

// ---------------------------------------------------------------------------
// Worker: no traversal-like id ever reaches/creates a coordinator
// ---------------------------------------------------------------------------
describe("worker rejects traversal-like profile ids", () => {
  // Every entry must be rejected with a route/validation error and MUST NOT
  // return a lease or coordinator state. We assert the union of acceptable
  // rejection outcomes because the URL parser normalizes some tokens into a
  // route miss (NOT_FOUND / METHOD_NOT_ALLOWED) before validation, while
  // others reach validateProfileId (VALIDATION_FAILED).
  const REJECT_STATUS = [404, 405, 422];
  const REJECT_CODE = ["NOT_FOUND", "METHOD_NOT_ALLOWED", "VALIDATION_FAILED"];

  const rawSegments: Array<{ name: string; seg: string }> = [
    { name: "single dot", seg: "." },
    { name: "double dot", seg: ".." },
    { name: "triple dot", seg: "..." },
    { name: "single dot (encoded)", seg: "%2e" },
    { name: "double dot (encoded)", seg: "%2e%2e" },
    { name: "double dot (mixed-case encoded)", seg: "%2E%2e" },
    { name: "encoded forward slash", seg: "%2fetc%2fpasswd" },
    { name: "encoded backslash", seg: "..%5c..%5cwindows" },
    { name: "encoded dot-dot-slash", seg: "%2e%2e%2f" },
    { name: "null byte (encoded)", seg: "profile%00" },
    { name: "newline (encoded)", seg: "profile%0aid" },
    { name: "tab (encoded)", seg: "profile%09id" },
    { name: "space (encoded)", seg: "profile%20id" },
    { name: "tilde", seg: "~" },
  ];

  for (const { name, seg } of rawSegments) {
    it(`GET rejects ${name} without a coordinator`, async () => {
      const res = await call("GET", `/v1/profiles/${seg}`);
      expect(REJECT_STATUS).toContain(res.status);
      expect(REJECT_CODE).toContain(res.json.error.code);
      expect(res.json.lease).toBeUndefined();
      expect(res.json.state).toBeUndefined();
    });

    it(`acquire on ${name} never mints a lease / creates a coordinator`, async () => {
      const res = await call("POST", `/v1/profiles/${seg}/acquire`, {
        body: { deviceId: "device_a", operationId: opId() },
      });
      // Never a success, never a lease — the id is turned away before any
      // coordinator RPC that would allocate a DO or issue a lease.
      expect(res.status).not.toBe(200);
      expect(REJECT_STATUS).toContain(res.status);
      expect(res.json?.lease).toBeUndefined();
      expect(res.json?.state).toBeUndefined();
    });
  }

  // Tokens that survive URL normalization and still decode to an unsafe single
  // segment are rejected specifically with VALIDATION_FAILED at the edge.
  const strictValidationFailures: Array<{ name: string; seg: string }> = [
    { name: "triple dot", seg: "..." },
    { name: "encoded forward slash", seg: "%2fetc%2fpasswd" },
    { name: "encoded backslash", seg: "..%5c..%5cwindows" },
    { name: "null byte (encoded)", seg: "profile%00" },
    { name: "tilde", seg: "~" },
  ];

  for (const { name, seg } of strictValidationFailures) {
    it(`GET on ${name} is specifically VALIDATION_FAILED(profileId)`, async () => {
      const res = await call("GET", `/v1/profiles/${seg}`);
      expect(res.status).toBe(422);
      expect(res.json.error.code).toBe("VALIDATION_FAILED");
      expect(res.json.error.details.field).toBe("profileId");
    });
  }

  const rawPaths: Array<{ name: string; path: string }> = [
    { name: "raw ../ traversal", path: "/v1/profiles/../secrets" },
    { name: "raw nested slashes", path: "/v1/profiles/a/b/c/d/e" },
  ];

  for (const { name, path } of rawPaths) {
    it(`GET ${name} is a route miss, no coordinator`, async () => {
      const res = await call("GET", path);
      expect(REJECT_STATUS).toContain(res.status);
      expect(REJECT_CODE).toContain(res.json.error.code);
      expect(res.json.lease).toBeUndefined();
    });
  }

  it("malformed percent-encoding is VALIDATION_FAILED, not an opaque 500", async () => {
    const res = await call("GET", "/v1/profiles/%C0");
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
    expect(res.json.error.details.field).toBe("profileId");
  });
});

// ---------------------------------------------------------------------------
// Worker: legitimate ids still work
// ---------------------------------------------------------------------------
describe("worker accepts legitimate profile ids", () => {
  it("accepts a normal UUID-style profile id (404, reaches coordinator, no state yet)", async () => {
    const profileId = `profile-${crypto.randomUUID()}`;
    const res = await call("GET", `/v1/profiles/${profileId}`);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");
  });

  it("accepts an allowed opaque id (dots/colons/dashes/underscores)", async () => {
    const profileId = "team_a.profile-01:v2";
    const res = await call("GET", `/v1/profiles/${encodeURIComponent(profileId)}`);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");
  });

  it("a valid id can actually acquire a lease (proves the happy path is intact)", async () => {
    const profileId = `profile-${crypto.randomUUID()}`;
    const res = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    expect(res.status).toBe(200);
    expect(typeof res.json.lease.leaseId).toBe("string");
  });
});
