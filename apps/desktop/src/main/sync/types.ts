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
  /** True when a worker URL + Access client id are configured. */
  configured: boolean;
  /** Whether the required secrets are present in the vault (never their values). */
  secretsPresent: {
    kopiaPassword: boolean;
    s3AccessKeyId: boolean;
    s3SecretAccessKey: boolean;
    accessClientSecret: boolean;
  };
  /** Last backend health probe result (null = never probed). */
  backendHealthy: boolean | null;
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
 * it contains NO vault contents, NO Access client secret, NO repository
 * password, NO S3 secret/access keys, and NO raw request headers. Only
 * presence booleans, non-secret config, revisions, timestamps, and redacted
 * messages appear here.
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
  /** Non-secret backend/config summary (worker host only, never the secret). */
  backend: {
    /** Configured worker origin (scheme+host), path/query stripped. Empty if unset. */
    workerOrigin: string;
    accessClientIdPresent: boolean;
    healthy: boolean | null;
    lastError: string | null;
  };
  /** Per-profile slices (all sync-enabled profiles, or a single requested one). */
  profiles: ProfileDiagnosticsView[];
}

/** Per-profile sync status for the UI. */
export interface ProfileSyncStatusView {
  profileId: string;
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

/**
 * Result of the first-run "Initialize Kopia Repository" operation. Carries no
 * secrets — only the non-secret repository target coordinates the operator can
 * verify, plus a completion flag.
 */
export interface RepositoryInitResult {
  /** True once `kopia repository create` completed successfully. */
  created: boolean;
  /** Non-secret S3/R2 target the repository was created against (for display). */
  target: {
    bucket: string;
    endpoint: string;
    region: string;
    prefix: string;
  };
}

/** Non-secret config the UI can read back and edit. */
export interface SyncConfigView {
  enabled: boolean;
  workerUrl: string;
  accessClientId: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  deviceId: string;
  deviceDisplayName: string;
  kopiaConfigPath: string;
  kopiaBinPath: string;
}

/** Which secret a save/delete/check targets. */
export type SecretKind =
  | "kopiaPassword"
  | "s3AccessKeyId"
  | "s3SecretAccessKey"
  | "accessClientSecret";

/** Generic operation result surfaced to the renderer. */
export type SyncOpResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: SyncErrorView };

/** Push event names emitted to the renderer. */
export interface SyncProgressEvent {
  /**
   * The profile this event relates to. For repository-level operations that
   * are not tied to a single profile (e.g. first-run repository init) this is
   * an empty string.
   */
  profileId: string;
  phase:
    | "acquiring"
    | "snapshotting"
    | "publishing"
    | "restoring"
    | "releasing"
    | "initializing"
    | "done"
    | "error";
  message: string;
}
