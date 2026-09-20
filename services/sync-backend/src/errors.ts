/**
 * Deterministic error codes and HTTP status mapping.
 *
 * Every failure path in the coordination API returns one of these codes with a
 * stable HTTP status so clients can branch on `code` rather than parsing prose.
 */
export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  /** Lease is currently held by another owner and is not expired. */
  LEASE_HELD: "LEASE_HELD",
  /** Caller presented a lease id / owner that does not match current holder. */
  LEASE_MISMATCH: "LEASE_MISMATCH",
  /** Lease has expired; caller must re-acquire. */
  LEASE_EXPIRED: "LEASE_EXPIRED",
  /** Presented fencingToken is stale or does not match the active lease. */
  FENCING_TOKEN_INVALID: "FENCING_TOKEN_INVALID",
  /** expectedRevision did not match the authoritative current revision. */
  REVISION_CONFLICT: "REVISION_CONFLICT",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCodeValue, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  LEASE_HELD: 409,
  LEASE_MISMATCH: 409,
  LEASE_EXPIRED: 409,
  FENCING_TOKEN_INVALID: 409,
  REVISION_CONFLICT: 409,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: Record<string, unknown>;
  };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export class ApiError extends Error {
  readonly code: ErrorCodeValue;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toResponse(): Response {
    const body: ApiErrorBody = {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
    return jsonResponse(body, this.status);
  }
}

export function errorResponse(
  code: ErrorCodeValue,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return new ApiError(code, message, details).toResponse();
}
