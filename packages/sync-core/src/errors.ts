/**
 * Deterministic, stable error codes for the sync domain.
 *
 * These values are part of the wire/telemetry contract: they are logged,
 * surfaced in diagnostics, and (later) sent to the coordination backend. Treat
 * them as append-only — never renumber or rename an existing member, only add
 * new ones. The string values intentionally equal the member names so that
 * serialization is stable regardless of how the enum is emitted.
 */
export enum SyncErrorCode {
  /** Sync is turned off for this profile (or globally). No remote state exists. */
  SyncDisabled = "SyncDisabled",
  /** The coordination backend / object storage could not be reached. */
  BackendUnreachable = "BackendUnreachable",
  /**
   * The backend rejected the request's credentials (HTTP 401/403) — typically a
   * missing/expired/misconfigured Cloudflare Access service token. Distinct from
   * {@link BackendUnreachable} so the UI can point the user at their Access
   * client id/secret rather than at networking.
   */
  BackendAuthFailed = "BackendAuthFailed",
  /** A required lease could not be acquired because another device owns it. */
  LeaseHeldByOther = "LeaseHeldByOther",
  /** The caller presented a fencing token older than the current one. */
  LeaseFenced = "LeaseFenced",
  /** The lease we relied on has expired before the operation completed. */
  LeaseExpired = "LeaseExpired",
  /** Local and remote diverged from a shared base — a conflict copy is required. */
  ConflictDetected = "ConflictDetected",
  /** A snapshot/upload was attempted while the browser was still running. */
  BrowserStillRunning = "BrowserStillRunning",
  /** The requested revision does not exist remotely. */
  RevisionNotFound = "RevisionNotFound",
  /** Local revision metadata is missing or inconsistent. */
  LocalStateCorrupt = "LocalStateCorrupt",
  /** A snapshot integrity check (hash/size) failed. */
  SnapshotIntegrityFailed = "SnapshotIntegrityFailed",
  /** The publish (revision bump) was rejected by the backend. */
  PublishRejected = "PublishRejected",
  /** Input to a decision/helper failed validation. */
  InvalidInput = "InvalidInput",
  /** Catch-all for unexpected failures. Prefer a specific code when possible. */
  Internal = "Internal",
}

/**
 * A structured, serializable sync error. `code` is the stable machine-readable
 * discriminant; `message` is a human-readable, secret-free explanation.
 */
export interface SyncError {
  code: SyncErrorCode;
  message: string;
  /** Optional non-secret structured context (ids, revisions, timers). */
  details?: Record<string, unknown>;
}

/** Construct a {@link SyncError}. Kept pure so it is trivially testable. */
export function syncError(
  code: SyncErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SyncError {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Type guard for {@link SyncError}. */
export function isSyncError(value: unknown): value is SyncError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    (Object.values(SyncErrorCode) as string[]).includes(v.code) &&
    typeof v.message === "string"
  );
}
