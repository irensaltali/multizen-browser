/**
 * Core sync domain contracts. These are browser-independent: nothing here
 * imports Chromium, Electron, better-sqlite3, or the app's profile types. The
 * package models *decisions and state*, not IO.
 */

/** Opaque profile identifier (same string space as the app's ProfileId). */
export type ProfileId = string;

/** Opaque, permanent, non-hardware-derived device identifier. */
export type DeviceId = string;

/**
 * Monotonic revision number for a profile's synced state. `0` is the sentinel
 * "no revision published yet". Revisions only ever increase.
 */
export type Revision = number;

/** Sentinel meaning "no revision has ever been published for this profile". */
export const NO_REVISION: Revision = 0;

/**
 * Opaque handle to an uploaded snapshot (e.g. a Kopia snapshot id). The sync
 * core treats it as an opaque token — it never parses or trusts its structure.
 */
export type SnapshotId = string;

/**
 * Local view of a profile's sync state, mirrored from the local SQLite
 * `profile_sync_state` table. This is the single source of truth the pure
 * decision functions consult.
 */
export interface ProfileSyncState {
  profileId: ProfileId;
  /** Whether cloud sync is enabled for this profile. Defaults to `false`. */
  syncEnabled: boolean;
  /** Highest revision this device has fully materialized locally. */
  localRevision: Revision;
  /**
   * Revision this device's local state was derived from — the common ancestor
   * used for three-way conflict detection. Updated on restore and on publish.
   */
  baseRevision: Revision;
  /**
   * Last remote revision this device observed. May lag the true remote value;
   * decisions treat it as "best known".
   */
  remoteRevision: Revision;
  /** Whether local state has un-published changes since {@link baseRevision}. */
  dirty: boolean;
  /** Latest snapshot id known for this profile, if any. */
  latestSnapshotId: SnapshotId | null;
  /** ISO-8601 timestamp of the last successful sync operation, if any. */
  lastSyncedAt: string | null;
}

/** A device's identity record, as tracked locally / in presence. */
export interface DeviceIdentity {
  deviceId: DeviceId;
  displayName: string;
  createdAt: string;
  lastSeen: string;
}

/**
 * A lease grants a single device the exclusive right to write (snapshot +
 * publish) a profile. Leases carry a monotonically increasing fencing token so
 * a stale owner that wakes up after expiry cannot corrupt newer state.
 */
export interface Lease {
  profileId: ProfileId;
  ownerDeviceId: DeviceId;
  /** Epoch milliseconds at which the lease expires if not renewed. */
  expiresAtMs: number;
  /**
   * Fencing token. Strictly increases every time ownership changes. A writer
   * must present a token >= the storage's current token to be accepted.
   */
  fencingToken: number;
}

/** A lease request from a device wanting to acquire/renew ownership. */
export interface LeaseRequest {
  profileId: ProfileId;
  deviceId: DeviceId;
  /** How long the requested lease should last, in milliseconds. */
  durationMs: number;
}

/** Result of evaluating a lease acquisition/renewal against current state. */
export type LeaseDecision =
  | { kind: "granted"; lease: Lease }
  | { kind: "renewed"; lease: Lease }
  | { kind: "denied"; ownerDeviceId: DeviceId; expiresAtMs: number };

/**
 * Authoritative per-profile coordination state (mirrors the backend Durable
 * Object). Kept here so decision functions can be exercised without a network.
 */
export interface ProfileCoordinationState {
  profileId: ProfileId;
  currentRevision: Revision;
  latestSnapshotId: SnapshotId | null;
  ownerDeviceId: DeviceId | null;
  leaseExpiresAtMs: number | null;
  fencingToken: number;
  updatedAtMs: number;
  updatedByDeviceId: DeviceId | null;
  handoffTargetDeviceId: DeviceId | null;
}
