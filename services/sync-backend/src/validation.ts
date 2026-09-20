import { ApiError, ErrorCode } from "./errors.js";

/**
 * Lightweight, dependency-free validation. Every validator throws an ApiError
 * with a deterministic code so the router can translate it directly into a
 * stable HTTP response.
 */

/**
 * Profile ids are opaque client-chosen slugs used verbatim as a *single* path
 * segment for on-disk / object-store layout (Kopia snapshots, R2 keys) and as
 * the Durable Object name. They must therefore be safe, non-traversing path
 * segments.
 *
 * The conservative charset already excludes path separators, control
 * characters, and whitespace, but the previous pattern still admitted
 * dot-only segments (`.`, `..`, `...`) which are directory-traversal tokens.
 * These are rejected explicitly below.
 */
const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Any value made up entirely of dots (`.`, `..`, `...`, …) is a traversal token. */
const DOTS_ONLY_RE = /^\.+$/;
/** Device ids follow the plan's `device_<hex>` convention but stay permissive. */
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Operation ids for idempotency: UUID-ish opaque tokens. */
const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
/** Snapshot ids are opaque Kopia references. */
const SNAPSHOT_ID_RE = /^[A-Za-z0-9._:/=+-]{1,256}$/;

export function assert(
  condition: unknown,
  code: keyof typeof ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw errCode(code, message);
}

function errCode(code: keyof typeof ErrorCode, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(ErrorCode[code], message, details);
}

export function validateProfileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_RE.test(value)) {
    throw errCode("VALIDATION_FAILED", "profileId must match /^[A-Za-z0-9._:-]{1,128}$/", {
      field: "profileId",
    });
  }
  // Reject path-traversal tokens. The charset already blocks `/`, `\`,
  // control chars, and whitespace, but dot-only segments (`.`, `..`, `...`)
  // pass the charset check yet resolve to the current/parent directory when
  // used as a path segment. A profile id must be a safe single segment.
  if (DOTS_ONLY_RE.test(value)) {
    throw errCode("VALIDATION_FAILED", "profileId must not be a dot-only path segment", {
      field: "profileId",
    });
  }
  return value;
}

export function validateDeviceId(value: unknown, field = "deviceId"): string {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) {
    throw errCode("VALIDATION_FAILED", `${field} must match /^[A-Za-z0-9._:-]{1,128}$/`, { field });
  }
  return value;
}

export function validateOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
    throw errCode("VALIDATION_FAILED", "operationId must match /^[A-Za-z0-9._:-]{8,128}$/", {
      field: "operationId",
    });
  }
  return value;
}

export function validateLeaseId(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 128) {
    throw errCode("VALIDATION_FAILED", "leaseId must be a 16-128 char string", { field: "leaseId" });
  }
  return value;
}

export function validateSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !SNAPSHOT_ID_RE.test(value)) {
    throw errCode("VALIDATION_FAILED", "latestSnapshotId must match /^[A-Za-z0-9._:/=+-]{1,256}$/", {
      field: "latestSnapshotId",
    });
  }
  return value;
}

/** Non-negative safe integer revision. */
export function validateRevision(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw errCode("VALIDATION_FAILED", `${field} must be a non-negative safe integer`, { field });
  }
  return value;
}

/** Positive safe integer fencing token (monotonic; starts at 1 on first acquire). */
export function validateFencingToken(value: unknown, field = "fencingToken"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw errCode("VALIDATION_FAILED", `${field} must be a positive safe integer`, { field });
  }
  return value;
}

export function optionalLeaseTtlMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1000 || value > 600_000) {
    throw errCode("VALIDATION_FAILED", "leaseTtlMs must be an integer between 1000 and 600000", {
      field: "leaseTtlMs",
    });
  }
  return value;
}

export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw errCode("BAD_REQUEST", "content-type must be application/json");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw errCode("BAD_REQUEST", "request body must be valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw errCode("BAD_REQUEST", "request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}
