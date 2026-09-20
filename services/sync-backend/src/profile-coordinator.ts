import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { ApiError, ErrorCode, type ErrorCodeValue } from "./errors.js";
import { generateLeaseId, hashLeaseId, timingSafeEqual } from "./crypto.js";
import type { Identity } from "./auth.js";

/**
 * Durable Object RPC serializes thrown errors and strips custom fields, so
 * every public method returns a structured envelope instead of throwing across
 * the RPC boundary. The Worker maps `{ ok: false }` envelopes to deterministic
 * HTTP responses. Internally we still use ApiError for control flow and unwrap
 * it into the envelope via `run()`.
 */
export interface CoordinatorError {
  code: ErrorCodeValue;
  message: string;
  details?: Record<string, unknown>;
}

export type CoordinatorResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; error: CoordinatorError };

/**
 * ProfileCoordinator — one SQLite-backed Durable Object per browser profile.
 *
 * Authoritative for:
 *  - current revision + latest snapshot id (immutable revision history rows)
 *  - single-writer ownership lease (hashed lease id, monotonic fencing token)
 *  - operation-id idempotency for mutating calls
 *
 * There is intentionally no R2/object access here — this DO only coordinates
 * metadata. The actual encrypted profile bytes live in the client's Kopia repo.
 */

const DEFAULT_LEASE_TTL_MS = 45_000;
const DEFAULT_RENEWAL_MS = 15_000;

export interface ProfileStateView {
  profileId: string;
  currentRevision: number;
  latestSnapshotId: string | null;
  ownerDeviceId: string | null;
  ownerSubject: string | null;
  ownerCommonName: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  updatedAt: number;
  updatedByDeviceId: string | null;
}

export interface LeaseResult {
  state: ProfileStateView;
  lease: {
    leaseId: string;
    fencingToken: number;
    leaseExpiresAt: number;
    leaseTtlMs: number;
    recommendedRenewalMs: number;
  };
}

export interface RevisionMeta {
  revision: number;
  snapshotId: string;
  deviceId: string;
  subject: string | null;
  fencingToken: number;
  operationId: string | null;
  createdAt: number;
}

export interface PublishResult {
  state: ProfileStateView;
  revision: number;
  revisionMeta: RevisionMeta;
}

export interface ReleaseResult {
  state: ProfileStateView;
  released: boolean;
}

interface AcquireInput {
  profileId: string;
  deviceId: string;
  operationId: string;
  leaseTtlMs?: number;
  identity: Identity;
}

interface RenewInput {
  profileId: string;
  deviceId: string;
  leaseId: string;
  fencingToken: number;
  operationId: string;
  leaseTtlMs?: number;
  identity: Identity;
}

interface PublishInput {
  profileId: string;
  deviceId: string;
  leaseId: string;
  fencingToken: number;
  operationId: string;
  expectedRevision: number;
  latestSnapshotId: string;
  identity: Identity;
}

interface ReleaseInput {
  profileId: string;
  deviceId: string;
  leaseId: string;
  fencingToken: number;
  operationId: string;
  identity: Identity;
}

type StateRow = {
  profile_id: string | null;
  current_revision: number;
  latest_snapshot_id: string | null;
  owner_device_id: string | null;
  owner_subject: string | null;
  owner_common_name: string | null;
  lease_hash: string | null;
  lease_expires_at: number | null;
  fencing_token: number;
  updated_at: number;
  updated_by_device_id: string | null;
};

export class ProfileCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        profile_id TEXT,
        current_revision INTEGER NOT NULL DEFAULT 0,
        latest_snapshot_id TEXT,
        owner_device_id TEXT,
        owner_subject TEXT,
        owner_common_name TEXT,
        lease_hash TEXT,
        lease_expires_at INTEGER,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        updated_by_device_id TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS revisions (
        revision INTEGER PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        subject TEXT,
        fencing_token INTEGER NOT NULL,
        operation_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Unwrap ApiError control flow into a serializable result envelope. */
  private async run<T>(fn: () => Promise<{ status: number; value: T }>): Promise<CoordinatorResult<T>> {
    try {
      const { status, value } = await fn();
      return { ok: true, status, value };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          ok: false,
          error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        };
      }
      return { ok: false, error: { code: ErrorCode.INTERNAL, message: "internal coordinator error" } };
    }
  }

  private leaseTtl(requested?: number): number {
    if (typeof requested === "number") return requested;
    const fromEnv = Number.parseInt(this.env.DEFAULT_LEASE_TTL_MS ?? "", 10);
    return Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_LEASE_TTL_MS;
  }

  private renewalMs(): number {
    const fromEnv = Number.parseInt(this.env.RECOMMENDED_RENEWAL_MS ?? "", 10);
    return Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RENEWAL_MS;
  }

  private now(): number {
    return Date.now();
  }

  private readRow(): StateRow | null {
    const rows = this.sql.exec("SELECT * FROM profile_state WHERE singleton = 1").toArray();
    if (rows.length === 0) return null;
    return rows[0] as unknown as StateRow;
  }

  private ensureRow(profileId: string): void {
    if (this.readRow()) return;
    this.sql.exec(
      `INSERT INTO profile_state (singleton, profile_id, current_revision, fencing_token, updated_at)
       VALUES (1, ?, 0, 0, ?)`,
      profileId,
      this.now(),
    );
  }

  private leaseActive(row: StateRow, at: number): boolean {
    return row.owner_device_id !== null && row.lease_expires_at !== null && row.lease_expires_at > at;
  }

  private toView(row: StateRow, profileId: string): ProfileStateView {
    const active = this.leaseActive(row, this.now());
    return {
      profileId: row.profile_id ?? profileId,
      currentRevision: row.current_revision,
      latestSnapshotId: row.latest_snapshot_id,
      ownerDeviceId: active ? row.owner_device_id : null,
      ownerSubject: active ? row.owner_subject : null,
      ownerCommonName: active ? row.owner_common_name : null,
      leaseExpiresAt: active ? row.lease_expires_at : null,
      fencingToken: row.fencing_token,
      updatedAt: row.updated_at,
      updatedByDeviceId: row.updated_by_device_id,
    };
  }

  // --- Idempotency ---------------------------------------------------------

  private readRevision(revision: number): RevisionMeta {
    const rows = this.sql
      .exec(
        "SELECT revision, snapshot_id, device_id, subject, fencing_token, operation_id, created_at FROM revisions WHERE revision = ?",
        revision,
      )
      .toArray();
    const r = rows[0] as {
      revision: number;
      snapshot_id: string;
      device_id: string;
      subject: string | null;
      fencing_token: number;
      operation_id: string | null;
      created_at: number;
    };
    return {
      revision: r.revision,
      snapshotId: r.snapshot_id,
      deviceId: r.device_id,
      subject: r.subject,
      fencingToken: r.fencing_token,
      operationId: r.operation_id,
      createdAt: r.created_at,
    };
  }

  private getStoredOperation(operationId: string): { status: number; value: unknown } | null {
    const rows = this.sql
      .exec("SELECT status, body FROM operations WHERE operation_id = ?", operationId)
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0] as { status: number; body: string };
    return { status: row.status, value: JSON.parse(row.body) };
  }

  private storeOperation(operationId: string, status: number, body: unknown): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO operations (operation_id, status, body, created_at) VALUES (?, ?, ?, ?)",
      operationId,
      status,
      JSON.stringify(body),
      this.now(),
    );
  }

  // --- Public read ---------------------------------------------------------

  getState(profileId: string): CoordinatorResult<{ state: ProfileStateView }> {
    const row = this.readRow();
    if (!row) {
      return {
        ok: false,
        error: {
          code: ErrorCode.NOT_FOUND,
          message: "profile has no coordination state yet",
          details: { profileId },
        },
      };
    }
    return { ok: true, status: 200, value: { state: this.toView(row, profileId) } };
  }

  // --- Mutations -----------------------------------------------------------

  acquire(input: AcquireInput): Promise<CoordinatorResult<LeaseResult>> {
    return this.run(async () => {
      const cached = this.getStoredOperation(input.operationId);
      if (cached) return { status: cached.status, value: cached.value as LeaseResult };

      this.ensureRow(input.profileId);
      const row = this.readRow()!;
      const now = this.now();

      if (this.leaseActive(row, now) && row.owner_device_id !== input.deviceId) {
        throw new ApiError(ErrorCode.LEASE_HELD, "profile lease is held by another device", {
          ownerDeviceId: row.owner_device_id,
          leaseExpiresAt: row.lease_expires_at,
        });
      }

      const ttl = this.leaseTtl(input.leaseTtlMs);
      const leaseId = generateLeaseId();
      const leaseHash = await hashLeaseId(leaseId);
      const fencingToken = row.fencing_token + 1; // monotonic on ownership change
      const expiresAt = now + ttl;

      this.sql.exec(
        `UPDATE profile_state SET
           profile_id = ?, owner_device_id = ?, owner_subject = ?, owner_common_name = ?,
           lease_hash = ?, lease_expires_at = ?, fencing_token = ?, updated_at = ?, updated_by_device_id = ?
         WHERE singleton = 1`,
        input.profileId,
        input.deviceId,
        input.identity.subject,
        input.identity.commonName,
        leaseHash,
        expiresAt,
        fencingToken,
        now,
        input.deviceId,
      );

      const value: LeaseResult = {
        state: this.toView(this.readRow()!, input.profileId),
        lease: {
          leaseId,
          fencingToken,
          leaseExpiresAt: expiresAt,
          leaseTtlMs: ttl,
          recommendedRenewalMs: this.renewalMs(),
        },
      };
      this.storeOperation(input.operationId, 200, value);
      return { status: 200, value };
    });
  }

  renew(input: RenewInput): Promise<CoordinatorResult<LeaseResult>> {
    return this.run(async () => {
      const cached = this.getStoredOperation(input.operationId);
      if (cached) return { status: cached.status, value: cached.value as LeaseResult };

      const row = this.readRow();
      if (!row || row.owner_device_id === null || row.lease_hash === null) {
        throw new ApiError(ErrorCode.LEASE_MISMATCH, "no active lease to renew");
      }
      const now = this.now();
      if (row.lease_expires_at === null || row.lease_expires_at <= now) {
        throw new ApiError(ErrorCode.LEASE_EXPIRED, "lease has expired; re-acquire required");
      }
      await this.verifyLease(row, input.deviceId, input.leaseId, input.fencingToken);

      const ttl = this.leaseTtl(input.leaseTtlMs);
      const expiresAt = now + ttl;
      // Renewal keeps the same fencing token; it only bumps on ownership change.
      this.sql.exec(
        "UPDATE profile_state SET lease_expires_at = ?, updated_at = ? WHERE singleton = 1",
        expiresAt,
        now,
      );

      const value: LeaseResult = {
        state: this.toView(this.readRow()!, input.profileId),
        lease: {
          leaseId: input.leaseId,
          fencingToken: row.fencing_token,
          leaseExpiresAt: expiresAt,
          leaseTtlMs: ttl,
          recommendedRenewalMs: this.renewalMs(),
        },
      };
      this.storeOperation(input.operationId, 200, value);
      return { status: 200, value };
    });
  }

  publish(input: PublishInput): Promise<CoordinatorResult<PublishResult>> {
    return this.run(async () => {
      const cached = this.getStoredOperation(input.operationId);
      if (cached) return { status: cached.status, value: cached.value as PublishResult };

      const row = this.readRow();
      if (!row || row.owner_device_id === null || row.lease_hash === null) {
        throw new ApiError(ErrorCode.LEASE_MISMATCH, "no active lease; acquire before publishing");
      }
      const now = this.now();
      if (row.lease_expires_at === null || row.lease_expires_at <= now) {
        throw new ApiError(ErrorCode.LEASE_EXPIRED, "lease has expired; re-acquire required");
      }
      await this.verifyLease(row, input.deviceId, input.leaseId, input.fencingToken);

      // Expected-revision CAS against authoritative current revision.
      if (input.expectedRevision !== row.current_revision) {
        throw new ApiError(ErrorCode.REVISION_CONFLICT, "expectedRevision does not match current revision", {
          expectedRevision: input.expectedRevision,
          currentRevision: row.current_revision,
        });
      }

      const newRevision = row.current_revision + 1;
      // Immutable revision row (PK on `revision`); idempotency guards retries.
      // operation_id is retained for audit/traceability of the publishing op.
      this.sql.exec(
        `INSERT INTO revisions (revision, snapshot_id, device_id, subject, fencing_token, operation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newRevision,
        input.latestSnapshotId,
        input.deviceId,
        input.identity.subject,
        row.fencing_token,
        input.operationId,
        now,
      );
      this.sql.exec(
        `UPDATE profile_state SET current_revision = ?, latest_snapshot_id = ?, updated_at = ?, updated_by_device_id = ?
         WHERE singleton = 1`,
        newRevision,
        input.latestSnapshotId,
        now,
        input.deviceId,
      );

      const revisionMeta = this.readRevision(newRevision);
      const value: PublishResult = {
        state: this.toView(this.readRow()!, input.profileId),
        revision: newRevision,
        revisionMeta,
      };
      this.storeOperation(input.operationId, 200, value);
      return { status: 200, value };
    });
  }

  release(input: ReleaseInput): Promise<CoordinatorResult<ReleaseResult>> {
    return this.run(async () => {
      const cached = this.getStoredOperation(input.operationId);
      if (cached) return { status: cached.status, value: cached.value as ReleaseResult };

      const row = this.readRow();
      if (!row || row.owner_device_id === null || row.lease_hash === null) {
        throw new ApiError(ErrorCode.LEASE_MISMATCH, "no active lease to release");
      }
      await this.verifyLease(row, input.deviceId, input.leaseId, input.fencingToken);

      const now = this.now();
      this.sql.exec(
        `UPDATE profile_state SET owner_device_id = NULL, owner_subject = NULL, owner_common_name = NULL,
           lease_hash = NULL, lease_expires_at = NULL, updated_at = ?, updated_by_device_id = ?
         WHERE singleton = 1`,
        now,
        input.deviceId,
      );

      const value: ReleaseResult = { state: this.toView(this.readRow()!, input.profileId), released: true };
      this.storeOperation(input.operationId, 200, value);
      return { status: 200, value };
    });
  }

  private async verifyLease(
    row: StateRow,
    deviceId: string,
    leaseId: string,
    fencingToken: number,
  ): Promise<void> {
    if (row.owner_device_id !== deviceId) {
      throw new ApiError(ErrorCode.LEASE_MISMATCH, "lease is owned by a different device");
    }
    const providedHash = await hashLeaseId(leaseId);
    if (row.lease_hash === null || !timingSafeEqual(providedHash, row.lease_hash)) {
      throw new ApiError(ErrorCode.LEASE_MISMATCH, "leaseId does not match active lease");
    }
    // Fencing token must match the token minted for the current ownership.
    // A stale or mismatched token is rejected deterministically so that a
    // holder from a previous ownership epoch cannot mutate state.
    if (fencingToken !== row.fencing_token) {
      throw new ApiError(ErrorCode.FENCING_TOKEN_INVALID, "fencingToken is stale or does not match active lease", {
        providedFencingToken: fencingToken,
        currentFencingToken: row.fencing_token,
      });
    }
  }
}
