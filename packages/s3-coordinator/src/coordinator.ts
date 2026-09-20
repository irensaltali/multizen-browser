/**
 * S3/R2-backed lease + revision coordinator.
 *
 * This replaces the Worker + Durable Object control plane with a coordinator
 * that needs NO server-side compute — only a strongly-consistent conditional
 * object store. Correctness rests entirely on atomic conditional writes:
 *
 *   - the profile's single `state.json` is created once with `If-None-Match: *`
 *     and thereafter updated with a read → validate → `If-Match` CAS loop,
 *   - a losing CAS (precondition/conflict) is retried from a FRESH read,
 *   - after a retry observes a different owner/takeover, the operation fails
 *     deterministically rather than clobbering the new owner.
 *
 * The public API mirrors the desktop {@link CoordinationClient} semantics so it
 * is a drop-in control plane: `health`, `capabilityProbe`, `getState`,
 * `acquire`, `renew`, `publish`, `release`, returning `BackendState`-shaped
 * views and `LeaseResult`/`PublishResult`/`ReleaseResult`.
 *
 * Time handling: leases are compared against the STORE's server clock when the
 * store exposes a `Date` header. When it does not, we fall back to local time
 * but apply the same clock-skew safety margin conservatively.
 */

import { randomUUID } from "node:crypto";
import { SyncErrorCode, syncError, type SyncError } from "@multizen/sync-core";
import {
  StoreError,
  StoreErrorKind,
  isStoreError,
  type ConditionalObjectStore,
} from "./store.js";
import {
  decodeState,
  encodeState,
  initialState,
  revisionKey,
  stateKey,
  assertSafeProfileId,
  type LastOperation,
  type ProfileState,
} from "./state.js";
import { runCapabilityProbe, type CapabilityProbeResult } from "./capability.js";

// ── result shapes (compatible with desktop CoordinationClient) ──────────────

export interface BackendState {
  profileId: string;
  currentRevision: number;
  latestSnapshotId: string | null;
  ownerDeviceId: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
}

export interface BackendLease {
  leaseId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  leaseTtlMs: number;
  recommendedRenewalMs: number;
}

export interface LeaseResult {
  state: BackendState;
  lease: BackendLease;
}

export interface PublishResult {
  state: BackendState;
  revision: number;
  /** Non-fatal warning when the immutable history record could not be written. */
  historyWarning?: string;
}

export interface ReleaseResult {
  state: BackendState;
  released: boolean;
}

export type StateResult =
  | { kind: "state"; state: BackendState }
  | { kind: "not-found" };

export interface S3CoordinatorConfig {
  /** Stable, non-hardware device id sent on every mutating call. */
  deviceId: string;
  /** Key prefix under which all coordination objects live. */
  controlPrefix?: string;
  /** Lease time-to-live in ms. Default 60_000. */
  leaseTtlMs?: number;
  /** Recommended renewal interval in ms. Default 15_000. */
  renewalMs?: number;
  /** Extra margin (ms) added before an expired lease may be taken over. Default 10_000. */
  clockSkewSafetyMs?: number;
  /** Max CAS retries per mutating operation. Default 8. */
  maxCasRetries?: number;
}

const DEFAULTS = {
  controlPrefix: "control",
  leaseTtlMs: 60_000,
  renewalMs: 15_000,
  clockSkewSafetyMs: 10_000,
  maxCasRetries: 8,
} as const;

/** Convert internal state to the public BackendState view. */
function toBackendState(s: ProfileState): BackendState {
  return {
    profileId: s.profileId,
    currentRevision: s.currentRevision,
    latestSnapshotId: s.latestSnapshotId,
    ownerDeviceId: s.ownerDeviceId,
    leaseExpiresAt: s.leaseExpiresAt,
    fencingToken: s.fencingToken,
  };
}

function leaseView(s: ProfileState, ttlMs: number, renewalMs: number): BackendLease {
  return {
    leaseId: s.leaseId ?? "",
    fencingToken: s.fencingToken,
    leaseExpiresAt: s.leaseExpiresAt ?? 0,
    leaseTtlMs: ttlMs,
    recommendedRenewalMs: renewalMs,
  };
}

interface LoadedState {
  state: ProfileState;
  etag: string;
  serverDateMs: number | null;
}

export class S3Coordinator {
  private readonly store: ConditionalObjectStore;
  private readonly deviceId: string;
  private readonly controlPrefix: string;
  private readonly leaseTtlMs: number;
  private readonly renewalMs: number;
  private readonly clockSkewSafetyMs: number;
  private readonly maxCasRetries: number;
  private capabilityCache: CapabilityProbeResult | null = null;

  constructor(store: ConditionalObjectStore, config: S3CoordinatorConfig) {
    if (!config.deviceId || typeof config.deviceId !== "string") {
      throw new Error("deviceId is required");
    }
    this.store = store;
    this.deviceId = config.deviceId;
    this.controlPrefix = config.controlPrefix ?? DEFAULTS.controlPrefix;
    this.leaseTtlMs = config.leaseTtlMs ?? DEFAULTS.leaseTtlMs;
    this.renewalMs = config.renewalMs ?? DEFAULTS.renewalMs;
    this.clockSkewSafetyMs = config.clockSkewSafetyMs ?? DEFAULTS.clockSkewSafetyMs;
    this.maxCasRetries = config.maxCasRetries ?? DEFAULTS.maxCasRetries;
  }

  // ── health / capability ───────────────────────────────────────────────────

  async health(): Promise<boolean> {
    return this.store.health();
  }

  /**
   * Prove the store enforces conditional writes. Result is cached per
   * coordinator instance on success. Writable operations refuse to run until
   * this passes.
   */
  async capabilityProbe(force = false): Promise<CapabilityProbeResult> {
    if (!force && this.capabilityCache?.ok) return this.capabilityCache;
    const result = await runCapabilityProbe(this.store, this.controlPrefix);
    if (result.ok) this.capabilityCache = result;
    return result;
  }

  private async ensureWritable(): Promise<void> {
    const probe = await this.capabilityProbe();
    if (!probe.ok) {
      throw syncError(
        SyncErrorCode.StorageUnreachable,
        `store failed capability probe (${probe.failedCheck ?? "unknown"})`,
        probe.message ? { detail: probe.message } : undefined,
      );
    }
  }

  // ── read ────────────────────────────────────────────────────────────────

  async getState(profileId: string): Promise<StateResult> {
    assertSafeProfileId(profileId);
    try {
      const loaded = await this.load(profileId);
      return { kind: "state", state: toBackendState(loaded.state) };
    } catch (err) {
      if (isStoreError(err) && err.kind === StoreErrorKind.NotFound) {
        return { kind: "not-found" };
      }
      throw this.wrap(err);
    }
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  async acquire(profileId: string, operationId: string): Promise<LeaseResult> {
    assertSafeProfileId(profileId);
    await this.ensureWritable();
    const { result } = await this.runCas<LeaseResult>(profileId, (loaded) =>
      this.applyAcquire(loaded, operationId),
    );
    return result;
  }

  async renew(
    profileId: string,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): Promise<LeaseResult> {
    assertSafeProfileId(profileId);
    await this.ensureWritable();
    const { result } = await this.runCas<LeaseResult>(profileId, (loaded) =>
      this.applyRenew(loaded, leaseId, fencingToken, operationId),
    );
    return result;
  }

  async publish(
    profileId: string,
    args: {
      leaseId: string;
      fencingToken: number;
      operationId: string;
      expectedRevision: number;
      latestSnapshotId: string;
    },
  ): Promise<PublishResult> {
    assertSafeProfileId(profileId);
    await this.ensureWritable();
    const { result, committed } = await this.runCas<PublishResult>(profileId, (loaded) =>
      this.applyPublish(loaded, args),
    );
    // Best-effort immutable history record; state remains authoritative.
    let historyWarning: string | undefined;
    if (committed) {
      historyWarning = await this.writeHistory(profileId, result.revision, args);
    }
    return historyWarning ? { ...result, historyWarning } : result;
  }

  async release(
    profileId: string,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): Promise<ReleaseResult> {
    assertSafeProfileId(profileId);
    await this.ensureWritable();
    const { result } = await this.runCas<ReleaseResult>(profileId, (loaded) =>
      this.applyRelease(loaded, leaseId, fencingToken, operationId),
    );
    return result;
  }

  // ── state load / create ─────────────────────────────────────────────────

  /**
   * Load the profile state. If it does not exist yet, create it once
   * (`If-None-Match: *`) then read it back — a lost create race resolves by
   * reading the winner's object.
   */
  private async load(profileId: string): Promise<LoadedState> {
    const key = stateKey(this.controlPrefix, profileId);
    try {
      const got = await this.store.get(key);
      const state = decodeState(got.bytes, profileId);
      return { state, etag: got.etag, serverDateMs: got.serverDateMs };
    } catch (err) {
      if (isStoreError(err) && err.kind === StoreErrorKind.NotFound) {
        throw err;
      }
      throw err;
    }
  }

  /** Load-or-create: guarantees a state object exists, returning it. */
  private async loadOrCreate(profileId: string): Promise<LoadedState> {
    const key = stateKey(this.controlPrefix, profileId);
    try {
      const got = await this.store.get(key);
      return { state: decodeState(got.bytes, profileId), etag: got.etag, serverDateMs: got.serverDateMs };
    } catch (err) {
      if (!(isStoreError(err) && err.kind === StoreErrorKind.NotFound)) throw err;
    }
    // Attempt initial creation.
    const fresh = initialState(profileId);
    try {
      await this.store.putCreate(key, encodeState(fresh));
    } catch (err) {
      if (!(isStoreError(err) && (err.kind === StoreErrorKind.PreconditionFailed || err.kind === StoreErrorKind.Conflict))) {
        throw err;
      }
      // Lost the create race — fall through to read the winner.
    }
    const got = await this.store.get(key);
    return { state: decodeState(got.bytes, profileId), etag: got.etag, serverDateMs: got.serverDateMs };
  }

  // ── CAS loops ─────────────────────────────────────────────────────────────

  /**
   * Generic read/validate/CAS loop. The `apply` callback maps the freshly-read
   * state to either an idempotent replay (`{ replay }`) or a committing
   * decision (`{ next, result }`), or throws a terminal {@link SyncError}. A
   * losing CAS retries from a FRESH read so a concurrent other-owner/takeover
   * observed on the next pass fails deterministically instead of clobbering.
   *
   * Returns whether the result was committed (a CAS actually ran) vs replayed,
   * so callers like publish can gate best-effort side effects on commit.
   */
  private async runCas<TResult>(
    profileId: string,
    apply: (loaded: LoadedState) => { replay: TResult } | { next: ProfileState; result: TResult },
  ): Promise<{ result: TResult; committed: boolean }> {
    const key = stateKey(this.controlPrefix, profileId);
    let attempt = 0;
    for (;;) {
      const loaded = await this.loadOrCreate(profileId);
      const applied = apply(loaded);
      if ("replay" in applied) {
        return { result: applied.replay, committed: false };
      }
      try {
        await this.store.putCompareAndSwap(key, encodeState(applied.next), loaded.etag);
        return { result: applied.result, committed: true };
      } catch (err) {
        if (this.isRetryableCas(err)) {
          attempt += 1;
          if (attempt > this.maxCasRetries) {
            throw syncError(SyncErrorCode.Internal, "exceeded max CAS retries", { profileId });
          }
          continue; // fresh read → re-evaluate
        }
        throw this.wrap(err);
      }
    }
  }

  private isRetryableCas(err: unknown): boolean {
    return (
      isStoreError(err) &&
      (err.kind === StoreErrorKind.PreconditionFailed || err.kind === StoreErrorKind.Conflict)
    );
  }

  // ── decision logic ─────────────────────────────────────────────────────────

  /** Effective "now" for lease reasoning: server clock if available, else local. */
  private effectiveNow(serverDateMs: number | null): number {
    return serverDateMs ?? Date.now();
  }

  private leaseActive(state: ProfileState, now: number): boolean {
    return (
      state.ownerDeviceId !== null &&
      state.leaseExpiresAt !== null &&
      state.leaseExpiresAt > now
    );
  }

  /** An expired lease may only be taken over past the skew safety margin. */
  private takeoverAllowed(state: ProfileState, now: number): boolean {
    if (state.ownerDeviceId === null || state.leaseExpiresAt === null) return true;
    return now >= state.leaseExpiresAt + this.clockSkewSafetyMs;
  }

  private applyAcquire(
    loaded: LoadedState,
    operationId: string,
  ): { replay: LeaseResult } | { next: ProfileState; result: LeaseResult } {
    const s = loaded.state;
    // Idempotent replay of the same acquire.
    if (s.lastOperation && s.lastOperation.kind === "acquire" && s.lastOperation.operationId === operationId) {
      return { replay: this.replayLease(s) };
    }
    const now = this.effectiveNow(loaded.serverDateMs);
    const active = this.leaseActive(s, now);
    if (active && s.ownerDeviceId !== this.deviceId) {
      // Another device holds an active lease → deny.
      throw syncError(SyncErrorCode.LeaseHeldByOther, "lease held by another device", {
        ownerDeviceId: s.ownerDeviceId,
        leaseExpiresAt: s.leaseExpiresAt,
      });
    }
    if (active && s.ownerDeviceId === this.deviceId) {
      // Same-device explicit reacquire → fresh lease, increment fencing.
      return this.grant(s, operationId, now);
    }
    // Not active: free, or expired.
    if (!this.takeoverAllowed(s, now)) {
      // Expired but within skew margin → too early to take over.
      throw syncError(SyncErrorCode.LeaseHeldByOther, "lease recently expired; within skew margin", {
        ownerDeviceId: s.ownerDeviceId,
        leaseExpiresAt: s.leaseExpiresAt,
      });
    }
    return this.grant(s, operationId, now);
  }

  private grant(
    s: ProfileState,
    operationId: string,
    now: number,
  ): { next: ProfileState; result: LeaseResult } {
    const leaseId = randomUUID();
    const fencingToken = s.fencingToken + 1;
    const leaseExpiresAt = now + this.leaseTtlMs;
    const next: ProfileState = {
      ...s,
      ownerDeviceId: this.deviceId,
      leaseId,
      leaseExpiresAt,
      fencingToken,
      updatedAt: new Date(now).toISOString(),
      updatedByDeviceId: this.deviceId,
      lastOperation: {
        operationId,
        kind: "acquire",
        revision: s.currentRevision,
        fencingToken,
        leaseId,
        leaseExpiresAt,
        latestSnapshotId: s.latestSnapshotId,
      },
    };
    return {
      next,
      result: {
        state: toBackendState(next),
        lease: leaseView(next, this.leaseTtlMs, this.renewalMs),
      },
    };
  }

  private applyRenew(
    loaded: LoadedState,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): { replay: LeaseResult } | { next: ProfileState; result: LeaseResult } {
    const s = loaded.state;
    if (s.lastOperation && s.lastOperation.kind === "renew" && s.lastOperation.operationId === operationId) {
      return { replay: this.replayLease(s) };
    }
    const now = this.effectiveNow(loaded.serverDateMs);
    this.requireOwner(s, leaseId, fencingToken, now);
    const leaseExpiresAt = now + this.leaseTtlMs;
    const next: ProfileState = {
      ...s,
      leaseExpiresAt,
      updatedAt: new Date(now).toISOString(),
      updatedByDeviceId: this.deviceId,
      lastOperation: {
        operationId,
        kind: "renew",
        revision: s.currentRevision,
        fencingToken: s.fencingToken,
        leaseId: s.leaseId ?? "",
        leaseExpiresAt,
        latestSnapshotId: s.latestSnapshotId,
      },
    };
    return {
      next,
      result: {
        state: toBackendState(next),
        lease: leaseView(next, this.leaseTtlMs, this.renewalMs),
      },
    };
  }

  private applyPublish(
    loaded: LoadedState,
    args: {
      leaseId: string;
      fencingToken: number;
      operationId: string;
      expectedRevision: number;
      latestSnapshotId: string;
    },
  ): { replay: PublishResult } | { next: ProfileState; result: PublishResult } {
    const s = loaded.state;
    if (s.lastOperation && s.lastOperation.kind === "publish" && s.lastOperation.operationId === args.operationId) {
      return {
        replay: {
          state: toBackendState(s),
          revision: s.lastOperation.revision,
        },
      };
    }
    const now = this.effectiveNow(loaded.serverDateMs);
    this.requireOwner(s, args.leaseId, args.fencingToken, now);
    if (args.expectedRevision !== s.currentRevision) {
      throw syncError(SyncErrorCode.PublishRejected, "expectedRevision does not match current", {
        expectedRevision: args.expectedRevision,
        currentRevision: s.currentRevision,
      });
    }
    const revision = s.currentRevision + 1;
    const leaseExpiresAt = now + this.leaseTtlMs; // publish may renew expiry
    const next: ProfileState = {
      ...s,
      currentRevision: revision,
      latestSnapshotId: args.latestSnapshotId,
      leaseExpiresAt,
      updatedAt: new Date(now).toISOString(),
      updatedByDeviceId: this.deviceId,
      lastOperation: {
        operationId: args.operationId,
        kind: "publish",
        revision,
        fencingToken: s.fencingToken,
        leaseId: s.leaseId ?? "",
        leaseExpiresAt,
        latestSnapshotId: args.latestSnapshotId,
      },
    };
    return { next, result: { state: toBackendState(next), revision } };
  }

  private applyRelease(
    loaded: LoadedState,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): { replay: ReleaseResult } | { next: ProfileState; result: ReleaseResult } {
    const s = loaded.state;
    if (s.lastOperation && s.lastOperation.kind === "release" && s.lastOperation.operationId === operationId) {
      return { replay: this.replayReleased(s) };
    }
    const now = this.effectiveNow(loaded.serverDateMs);
    this.requireOwner(s, leaseId, fencingToken, now);
    const next: ProfileState = {
      ...s,
      ownerDeviceId: null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: new Date(now).toISOString(),
      updatedByDeviceId: this.deviceId,
      lastOperation: {
        operationId,
        kind: "release",
        revision: s.currentRevision,
        fencingToken: s.fencingToken,
        leaseId: "",
        leaseExpiresAt: null,
        latestSnapshotId: s.latestSnapshotId,
      },
    };
    // NOTE: the state object is updated, never deleted.
    return {
      next,
      result: { state: toBackendState(next), released: true },
    };
  }

  /**
   * Enforce exact owner + lease id + fencing token AND an unexpired lease.
   * Throws the appropriate {@link SyncError} otherwise.
   */
  private requireOwner(
    s: ProfileState,
    leaseId: string,
    fencingToken: number,
    now: number,
  ): void {
    if (s.ownerDeviceId !== this.deviceId || s.leaseId === null) {
      throw syncError(SyncErrorCode.LeaseHeldByOther, "caller does not own the lease", {
        ownerDeviceId: s.ownerDeviceId,
      });
    }
    if (s.leaseId !== leaseId) {
      throw syncError(SyncErrorCode.LeaseHeldByOther, "lease id mismatch");
    }
    if (fencingToken !== s.fencingToken) {
      throw syncError(SyncErrorCode.LeaseFenced, "fencing token mismatch", {
        presented: fencingToken,
        current: s.fencingToken,
      });
    }
    if (s.leaseExpiresAt === null || s.leaseExpiresAt <= now) {
      throw syncError(SyncErrorCode.LeaseExpired, "lease expired", {
        leaseExpiresAt: s.leaseExpiresAt,
        now,
      });
    }
  }

  private replayLease(s: ProfileState): LeaseResult {
    return {
      state: toBackendState(s),
      lease: leaseView(s, this.leaseTtlMs, this.renewalMs),
    };
  }

  private replayReleased(s: ProfileState): ReleaseResult {
    return {
      state: toBackendState(s),
      released: true,
    };
  }

  // ── history ─────────────────────────────────────────────────────────────

  /**
   * Best-effort immutable revision record. A failure here is reported as a
   * warning but does NOT undo the committed state CAS.
   */
  private async writeHistory(
    profileId: string,
    revision: number,
    args: { operationId: string; latestSnapshotId: string; leaseId: string; fencingToken: number },
  ): Promise<string | undefined> {
    try {
      const key = revisionKey(this.controlPrefix, revision, args.operationId);
      const record = {
        profileId,
        revision,
        operationId: args.operationId,
        latestSnapshotId: args.latestSnapshotId,
        fencingToken: args.fencingToken,
        deviceId: this.deviceId,
        at: new Date().toISOString(),
      };
      await this.store.putImmutable(key, new TextEncoder().encode(JSON.stringify(record)));
      return undefined;
    } catch (err) {
      if (isStoreError(err) && (err.kind === StoreErrorKind.PreconditionFailed || err.kind === StoreErrorKind.Conflict)) {
        // Record already exists (idempotent replay wrote it) — not a warning.
        return undefined;
      }
      const message = isStoreError(err) ? `${err.kind}: ${err.message}` : String(err);
      return `history record not written: ${message}`;
    }
  }

  // ── error mapping ──────────────────────────────────────────────────────────

  private wrap(err: unknown): SyncError {
    if (isSyncErrorLike(err)) return err;
    if (isStoreError(err)) {
      switch (err.kind) {
        case StoreErrorKind.NotFound:
          return syncError(SyncErrorCode.RevisionNotFound, err.message, { httpStatus: err.httpStatus });
        case StoreErrorKind.AuthFailed:
          return syncError(SyncErrorCode.StorageAuthFailed, err.message, { httpStatus: err.httpStatus });
        case StoreErrorKind.Unreachable:
          return syncError(SyncErrorCode.StorageUnreachable, err.message, { httpStatus: err.httpStatus });
        case StoreErrorKind.Malformed:
          return syncError(SyncErrorCode.LocalStateCorrupt, err.message);
        case StoreErrorKind.PreconditionFailed:
        case StoreErrorKind.Conflict:
          return syncError(SyncErrorCode.PublishRejected, err.message, { httpStatus: err.httpStatus });
        default:
          return syncError(SyncErrorCode.Internal, err.message);
      }
    }
    return syncError(SyncErrorCode.Internal, err instanceof Error ? err.message : String(err));
  }
}

function isSyncErrorLike(err: unknown): err is SyncError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string" &&
    (Object.values(SyncErrorCode) as string[]).includes((err as { code: string }).code)
  );
}

export type { LastOperation };
