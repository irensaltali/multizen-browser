/**
 * Shared, serializable types for the sync feature. These cross the IPC
 * boundary (main ↔ preload ↔ renderer), so everything here is plain JSON —
 * no class instances, no functions.
 */

import type { SyncErrorCode } from "@multizen/sync-core";

/** A structured, redacted error surfaced to the renderer. */
export interface SyncErrorView {
  code: SyncErrorCode | string;
  message: string;
}

/** Overall + per-profile diagnostics snapshot. */
export interface SyncDiagnostics {
  /** Master switch. */
  enabled: boolean;
  /** True when a storage bucket is configured (minimum to coordinate). */
  configured: boolean;
  /** Whether the required secrets are present in the vault (never their values). */
  secretsPresent: {
    kopiaPassword: boolean;
    s3AccessKeyId: boolean;
    s3SecretAccessKey: boolean;
  };
  /** Last storage-coordinator health probe result (null = never probed). */
  storeHealthy: boolean | null;
  /**
   * Last conditional-write capability probe result (null = never probed).
   * `ok` reflects whether the store enforces the conditional writes coordination
   * depends on; `failedCheck` names the failing invariant when not ok.
   */
  capability: {
    ok: boolean;
    failedCheck: string | null;
  } | null;
  /** S3/R2 bucket the repository + control plane live in (non-secret). */
  bucket: string;
  /** Coordination control-object key prefix (non-secret). */
  controlPrefix: string;
  deviceId: string;
  deviceDisplayName: string;
  /** Kopia binary path the resolver selected (non-secret). */
  kopiaBinPath: string;
}

/** A single sync journal entry, with any secret values already redacted. */
export interface SyncOperationView {
  id: string;
  kind: "backup" | "restore" | "publish" | "handoff";
  status: "pending" | "running" | "succeeded" | "failed";
  fromRevision: number | null;
  toRevision: number | null;
  snapshotId: string | null;
  /** Redacted human message (never a secret). */
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-profile diagnostics slice included in the export. */
export interface ProfileDiagnosticsView {
  profileId: string;
  syncEnabled: boolean;
  dirty: boolean;
  /** Local / base / remote revisions from the local sync-state row. */
  localRevision: number;
  baseRevision: number;
  remoteRevision: number;
  latestSnapshotId: string | null;
  lastSyncedAt: string | null;
  /** True when this device currently holds an in-memory lease. */
  hasLease: boolean;
  /** In-memory lease expiry (epoch ms) when held on this device, else null. */
  localLeaseExpiresAt: number | null;
  /** True when the profile's Chromium is currently running. */
  running: boolean;
  /**
   * Best-effort coordination state fetched from the backend (owner + lease).
   * Null when sync isn't configured/enabled or the backend was unreachable —
   * NEVER contains secrets (no headers, no tokens).
   */
  owner: {
    ownerDeviceId: string | null;
    leaseExpiresAt: number | null;
    currentRevision: number;
    latestSnapshotId: string | null;
    fencingToken: number;
  } | null;
  /** Newest sync journal entry for the profile (redacted), if any. */
  lastOperation: SyncOperationView | null;
}

/**
 * A sanitized, exportable diagnostics bundle. Safe to write to disk / share:
 * it contains NO vault contents, NO repository password, NO S3 secret/access
 * keys, and NO SDK/client credentials. Only presence booleans, non-secret
 * config, revisions, timestamps, and redacted messages appear here.
 */
export interface SyncDiagnosticsExport {
  /** ISO timestamp the export was generated. */
  generatedAt: string;
  /** App + product version, for support triage. */
  appVersion: string;
  /** Host platform + arch (non-identifying). */
  platform: string;
  arch: string;
  /** Pinned Kopia version this build embeds. */
  kopiaPinnedVersion: string;
  /** True when the resolved Kopia binary exists on disk. */
  kopiaBinPresent: boolean;
  /** App-level diagnostics (already secret-free). */
  app: SyncDiagnostics;
  /**
   * Non-secret storage-coordinator summary. Reports store health, the last
   * conditional-write capability result, the bucket + control prefix, and NEVER
   * any credential value.
   */
  storage: {
    /** S3/R2 bucket (non-secret). */
    bucket: string;
    /** S3/R2 endpoint host (non-secret). Empty when using AWS default. */
    endpoint: string;
    /** S3/R2 region (non-secret). */
    region: string;
    /** Coordination control-object key prefix (non-secret). */
    controlPrefix: string;
    /** Kopia repository object prefix (non-secret). */
    kopiaPrefix: string;
    /** Whether S3/R2 access credentials are present in the vault. */
    credentialsPresent: boolean;
    /** Last store health probe result. */
    healthy: boolean | null;
    /** Last conditional-write capability probe result. */
    capability: { ok: boolean; failedCheck: string | null } | null;
    lastError: string | null;
  };
  /** Per-profile slices (all sync-enabled profiles, or a single requested one). */
  profiles: ProfileDiagnosticsView[];
}

/** Per-profile sync status for the UI. */
export interface ProfileSyncStatusView {
  profileId: string;
  /**
   * Master switch state. When false, all cloud operations are refused; the
   * renderer disables Acquire/Restore/Backup/Release and per-profile enable.
   */
  globalEnabled: boolean;
  syncEnabled: boolean;
  dirty: boolean;
  localRevision: number;
  baseRevision: number;
  remoteRevision: number;
  latestSnapshotId: string | null;
  lastSyncedAt: string | null;
  /** True when this device currently holds an in-memory lease for the profile. */
  hasLease: boolean;
  /** Lease expiry (epoch ms) when held, else null. */
  leaseExpiresAt: number | null;
  /** True when the profile's Chromium is currently running. */
  running: boolean;
}

/** Non-secret config the UI can read back and edit. */
export interface SyncConfigView {
  enabled: boolean;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  /** Coordination control-object key prefix (separate from the Kopia prefix). */
  controlPrefix: string;
  /** Path-style S3 addressing toggle (required by some S3-compatible providers). */
  s3ForcePathStyle: boolean;
  /** Lease time-to-live in ms. */
  leaseTtlMs: number;
  /** Recommended lease renewal interval in ms. */
  renewalMs: number;
  /** Clock-skew safety margin in ms. */
  clockSkewSafetyMs: number;
  deviceId: string;
  deviceDisplayName: string;
  kopiaConfigPath: string;
  kopiaBinPath: string;
}

/** Which secret a save/delete/check targets. */
export type SecretKind = "kopiaPassword" | "s3AccessKeyId" | "s3SecretAccessKey";

/**
 * Result of "Test storage coordination": store reachability plus a FORCED
 * conditional-write capability probe. Carries no secrets.
 */
export interface StorageTestResult {
  /** Store reachable + authorized. */
  healthy: boolean;
  /** Conditional-write capability probe outcome. */
  capability: {
    ok: boolean;
    /** Which invariant failed when not ok (create/cas/etc.), else null. */
    failedCheck: string | null;
    /** Redacted human detail, if any. */
    message: string | null;
  };
  /** True only when both health passed AND conditional writes are supported. */
  conditionalWritesSupported: boolean;
}

/** Generic operation result surfaced to the renderer. */
export type SyncOpResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: SyncErrorView };

/** Push event names emitted to the renderer. */
export interface SyncProgressEvent {
  /**
   * The profile this event relates to. For repository-level operations that
   * are not tied to a single profile this is an empty string.
   */
  profileId: string;
  phase:
    | "acquiring"
    | "snapshotting"
    | "publishing"
    | "restoring"
    | "releasing"
    | "done"
    | "error";
  message: string;
}

/**
 * Per-profile outcome of a whole-library bootstrap run. `action` describes what
 * the bootstrap did (or attempted) for the profile; `ok` is false when the step
 * failed (the run continues to the next profile — partial failures never abort
 * the whole bootstrap).
 */
export interface BootstrapProfileResult {
  profileId: string;
  action: "restored" | "uploaded" | "deferred-running" | "reconciled" | "skipped" | "failed";
  ok: boolean;
  /** Redacted human detail (never a secret). Present on failure or when notable. */
  message?: string;
}

/**
 * Whole-library bootstrap summary. Returned by a run and cached for status/UI.
 * Never carries secrets. `phase` reflects the single-flight state machine.
 */
export interface BootstrapSummary {
  /** Lifecycle phase of the most recent (or in-flight) bootstrap. */
  phase: "idle" | "running" | "done" | "error";
  /** True while a bootstrap is actively running (single-flight guard). */
  running: boolean;
  /** ISO timestamp the last run started, or null if never run. */
  startedAt: string | null;
  /** ISO timestamp the last run finished, or null if never finished. */
  finishedAt: string | null;
  /** Count of remote profiles discovered on the last run. */
  remoteDiscovered: number;
  /** Count of local profiles restored from remote (missing locally). */
  restored: number;
  /** Count of local profiles uploaded as a fresh/dirty baseline. */
  uploaded: number;
  /** Count of running profiles whose upload was deferred to close. */
  deferred: number;
  /** Count of profiles reconciled (already present locally + remotely). */
  reconciled: number;
  /** Count of per-profile failures (the run still completed). */
  failed: number;
  /** True when the remote listing hit the coordinator's scan safety cap. */
  remoteTruncated: boolean;
  /** Per-profile results (redacted). */
  results: BootstrapProfileResult[];
  /** Last redacted error message when `phase === "error"`, else null. */
  error: string | null;
}

/** Result of a destructive per-profile remote-disable (delete). */
export interface DisableProfileSyncResult {
  profileId: string;
  /** True when the remote logical deletion succeeded and local sync was disabled. */
  disabled: boolean;
  /** Snapshot manifest ids deleted from Kopia (may be empty if none existed). */
  deletedSnapshotIds: string[];
  /** Redacted human detail (never a secret). */
  message: string | null;
}
