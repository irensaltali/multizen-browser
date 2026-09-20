/**
 * Pure decision functions for the sync lifecycle.
 *
 * Every function here is deterministic and side-effect free: given the same
 * inputs it returns the same output, performs no IO, and reads no clock unless
 * the current time is passed in explicitly (`nowMs`). This makes the core sync
 * policy exhaustively unit-testable without a browser, network, or filesystem.
 *
 * The policy implemented mirrors the product plan:
 *   - one active writer per profile (leases + fencing),
 *   - never merge Chromium state,
 *   - on divergence, keep both (conflict copy).
 */
import { SyncErrorCode, syncError, type SyncError } from "./errors.js";
import {
  NO_REVISION,
  type Lease,
  type LeaseDecision,
  type LeaseRequest,
  type ProfileCoordinationState,
  type ProfileSyncState,
  type Revision,
} from "./types.js";

// ── Launch ────────────────────────────────────────────────────────────────

/**
 * What the caller should do when the user asks to open a profile.
 *   - `launch`            : local state is current; just launch.
 *   - `restore-then-launch`: remote is newer & local is clean; pull first.
 *   - `conflict`          : local dirty AND remote advanced past base — must
 *                           preserve both (create a conflict copy).
 *   - `blocked`           : cannot proceed (returns a structured reason).
 */
export type LaunchDecision =
  | { action: "launch" }
  | { action: "restore-then-launch"; targetRevision: Revision }
  | { action: "conflict"; baseRevision: Revision; remoteRevision: Revision }
  | { action: "blocked"; error: SyncError };

/**
 * Decide how to open a profile given local sync state and the best-known remote
 * revision. Pure — no clock, no IO.
 *
 * Decision table (sync enabled):
 *   remote <= local            → launch                (local is up to date)
 *   remote > local, !dirty     → restore-then-launch   (fast-forward)
 *   remote > base,  dirty      → conflict              (both sides changed)
 *   remote <= base, dirty      → launch                (only we changed; publish later)
 */
export function decideLaunch(state: ProfileSyncState, remoteRevision: Revision): LaunchDecision {
  if (!state.syncEnabled) {
    // Sync off → behave exactly like today: just launch, no remote coupling.
    return { action: "launch" };
  }
  if (remoteRevision < NO_REVISION || state.localRevision < NO_REVISION) {
    return {
      action: "blocked",
      error: syncError(SyncErrorCode.LocalStateCorrupt, "Negative revision encountered", {
        localRevision: state.localRevision,
        remoteRevision,
      }),
    };
  }

  if (remoteRevision <= state.localRevision) {
    return { action: "launch" };
  }

  // remote is strictly ahead of what we have materialized.
  if (state.dirty && remoteRevision > state.baseRevision) {
    return {
      action: "conflict",
      baseRevision: state.baseRevision,
      remoteRevision,
    };
  }

  if (!state.dirty) {
    return { action: "restore-then-launch", targetRevision: remoteRevision };
  }

  // Dirty, but remote did not advance past our base → our edits are safe to
  // keep; nothing to restore, publish happens on close.
  return { action: "launch" };
}

// ── Restore ─────────────────────────────────────────────────────────────────

/** Whether a restore should run before launch, and to which revision. */
export type RestoreDecision =
  | { action: "skip" }
  | { action: "restore"; targetRevision: Revision; snapshotRequired: true }
  | { action: "blocked"; error: SyncError };

/**
 * Decide whether to restore. A restore is required only when the remote is
 * strictly newer than local AND local is clean (no unpublished edits to lose).
 * If local is dirty and remote advanced, that's a conflict, not a restore.
 */
export function decideRestore(state: ProfileSyncState, remoteRevision: Revision): RestoreDecision {
  if (!state.syncEnabled) return { action: "skip" };
  if (remoteRevision <= state.localRevision) return { action: "skip" };
  if (state.dirty && remoteRevision > state.baseRevision) {
    return {
      action: "blocked",
      error: syncError(
        SyncErrorCode.ConflictDetected,
        "Cannot restore over locally-modified profile",
        { baseRevision: state.baseRevision, remoteRevision },
      ),
    };
  }
  return { action: "restore", targetRevision: remoteRevision, snapshotRequired: true };
}

// ── Conflict ──────────────────────────────────────────────────────────────

/** Classification of the relationship between local and remote state. */
export type ConflictOutcome =
  | { kind: "none" }
  | { kind: "fast-forward"; targetRevision: Revision }
  | { kind: "local-ahead" }
  | { kind: "conflict"; baseRevision: Revision; remoteRevision: Revision };

/**
 * Classify local vs remote using three-way (base/local/remote) reasoning.
 * This is the single source of truth the launch/restore/publish helpers build
 * on. Never merges — a true divergence is always reported as `conflict`.
 */
export function classifyConflict(
  state: ProfileSyncState,
  remoteRevision: Revision,
): ConflictOutcome {
  const remoteAdvanced = remoteRevision > state.baseRevision;
  const remoteNewerThanLocal = remoteRevision > state.localRevision;

  if (!state.dirty) {
    if (remoteNewerThanLocal) return { kind: "fast-forward", targetRevision: remoteRevision };
    return { kind: "none" };
  }
  // dirty
  if (remoteAdvanced) {
    return { kind: "conflict", baseRevision: state.baseRevision, remoteRevision };
  }
  return { kind: "local-ahead" };
}

/**
 * Build the display name for a conflict copy, e.g.
 * `"Amazon US" + "Mac Studio" → "Amazon US - Conflict - Mac Studio"`.
 * Deterministic and stable so callers can dedupe.
 */
export function conflictCopyName(baseName: string, deviceDisplayName: string): string {
  const base = baseName.trim();
  const device = deviceDisplayName.trim();
  const suffix = device.length > 0 ? ` - Conflict - ${device}` : " - Conflict";
  return `${base}${suffix}`;
}

// ── Publish ───────────────────────────────────────────────────────────────

/** Whether to publish (snapshot + upload + revision bump) on profile close. */
export type PublishDecision =
  | { action: "skip"; reason: "sync-disabled" | "not-dirty" }
  | { action: "publish"; expectedBaseRevision: Revision; nextRevision: Revision }
  | { action: "blocked"; error: SyncError };

/**
 * Decide whether to publish local state when a profile closes.
 *
 * Preconditions the caller must guarantee (verified here defensively):
 *   - the browser has fully exited (`browserExited`),
 *   - this device holds a valid, unexpired lease.
 *
 * Publish is skipped when sync is off or there is nothing dirty to push.
 * Publish is blocked (never merges) when the remote advanced past our base —
 * that path must go through conflict handling instead.
 */
export function decidePublish(
  state: ProfileSyncState,
  remoteRevision: Revision,
  ctx: { browserExited: boolean; lease: Lease | null; nowMs: number; deviceId: string },
): PublishDecision {
  if (!state.syncEnabled) return { action: "skip", reason: "sync-disabled" };
  if (!state.dirty) return { action: "skip", reason: "not-dirty" };

  if (!ctx.browserExited) {
    return {
      action: "blocked",
      error: syncError(
        SyncErrorCode.BrowserStillRunning,
        "Refusing to snapshot while the browser is still running",
        { profileId: state.profileId },
      ),
    };
  }

  const lease = ctx.lease;
  if (!lease || lease.profileId !== state.profileId || lease.ownerDeviceId !== ctx.deviceId) {
    return {
      action: "blocked",
      error: syncError(SyncErrorCode.LeaseHeldByOther, "No owned lease for publish", {
        profileId: state.profileId,
      }),
    };
  }
  if (lease.expiresAtMs <= ctx.nowMs) {
    return {
      action: "blocked",
      error: syncError(SyncErrorCode.LeaseExpired, "Lease expired before publish", {
        expiresAtMs: lease.expiresAtMs,
        nowMs: ctx.nowMs,
      }),
    };
  }

  if (remoteRevision > state.baseRevision) {
    return {
      action: "blocked",
      error: syncError(
        SyncErrorCode.ConflictDetected,
        "Remote advanced past base — publish must resolve conflict first",
        { baseRevision: state.baseRevision, remoteRevision },
      ),
    };
  }

  const anchor = Math.max(state.localRevision, remoteRevision, state.baseRevision);
  return {
    action: "publish",
    expectedBaseRevision: state.baseRevision,
    nextRevision: anchor + 1,
  };
}

// ── Lease / fencing ─────────────────────────────────────────────────────────

/**
 * Evaluate a lease acquire/renew request against the current coordination
 * state. Pure — the caller supplies `nowMs`. Renewals by the current owner and
 * takeovers of an expired lease both increment the fencing token only on
 * *ownership change* (renewals keep the token, per the fencing contract:
 * the token identifies an ownership epoch, not each renewal).
 */
export function evaluateLease(
  coord: ProfileCoordinationState,
  req: LeaseRequest,
  nowMs: number,
): LeaseDecision {
  const leaseActive =
    coord.ownerDeviceId !== null &&
    coord.leaseExpiresAtMs !== null &&
    coord.leaseExpiresAtMs > nowMs;

  const expiresAtMs = nowMs + req.durationMs;

  if (!leaseActive) {
    // Free (never owned or expired) → grant, new ownership epoch.
    return {
      kind: "granted",
      lease: {
        profileId: req.profileId,
        ownerDeviceId: req.deviceId,
        expiresAtMs,
        fencingToken: coord.fencingToken + 1,
      },
    };
  }

  if (coord.ownerDeviceId === req.deviceId) {
    // Same owner renewing → keep the fencing token (same epoch).
    return {
      kind: "renewed",
      lease: {
        profileId: req.profileId,
        ownerDeviceId: req.deviceId,
        expiresAtMs,
        fencingToken: coord.fencingToken,
      },
    };
  }

  // Held by someone else and still valid → deny.
  return {
    kind: "denied",
    ownerDeviceId: coord.ownerDeviceId as string,
    expiresAtMs: coord.leaseExpiresAtMs as number,
  };
}

/**
 * Fencing check applied at the storage boundary: a writer's token must be
 * greater-than-or-equal to the current authoritative token. A strictly smaller
 * token means the writer is a stale owner and must be rejected.
 */
export function isFencingTokenValid(currentToken: number, presentedToken: number): boolean {
  return presentedToken >= currentToken;
}

/** True when a lease is expired (or absent) at the given time. */
export function isLeaseExpired(lease: Lease | null, nowMs: number): boolean {
  if (!lease) return true;
  return lease.expiresAtMs <= nowMs;
}
