/**
 * HTTP client for the coordination backend (services/sync-backend).
 *
 * Mirrors the Worker's contract EXACTLY:
 *   - GET  /v1/profiles/:id                    → current state
 *   - POST /v1/profiles/:id/acquire            { deviceId, operationId }
 *   - POST /v1/profiles/:id/renew              { deviceId, leaseId, fencingToken, operationId }
 *   - POST /v1/profiles/:id/publish            { deviceId, leaseId, fencingToken, operationId,
 *                                                expectedRevision, latestSnapshotId }
 *   - POST /v1/profiles/:id/release            { deviceId, leaseId, fencingToken, operationId }
 *   - GET  /health                             (unauthenticated liveness)
 *
 * All /v1 routes require Cloudflare Access. This client authenticates using a
 * service token via the `CF-Access-Client-Id` / `CF-Access-Client-Secret`
 * headers (the secret comes from the credential vault, never settings).
 *
 * Backend error codes are translated into deterministic {@link SyncError}s so
 * the controller branches on `code`, never on prose.
 */

import {
  SyncErrorCode,
  syncError,
  type SyncError,
} from "@multizen/sync-core";

/** Public state view returned by the backend (see ProfileStateView). */
export interface BackendState {
  profileId: string;
  currentRevision: number;
  latestSnapshotId: string | null;
  ownerDeviceId: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
}

/** Lease block returned by acquire/renew. */
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
}

export interface ReleaseResult {
  state: BackendState;
  released: boolean;
}

/** Result of a state fetch — distinguishes "no revision yet" from an error. */
export type StateResult =
  | { kind: "state"; state: BackendState }
  | { kind: "not-found" };

export interface CoordinationClientConfig {
  /** Backend base URL, e.g. `https://sync.example.com`. No trailing slash needed. */
  workerUrl: string;
  /** Cloudflare Access service-token client id (public). */
  accessClientId: string;
  /** Cloudflare Access service-token client secret (from the vault). */
  accessClientSecret: string;
  /** Device id sent on every mutating call. */
  deviceId: string;
  /** Per-request timeout. Defaults to 15s. */
  timeoutMs?: number;
}

/** Injectable fetch so tests can stub the network without a real server. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

/** Map a backend error code string → a stable SyncErrorCode. */
function mapBackendCode(code: string): SyncErrorCode {
  switch (code) {
    case "LEASE_HELD":
      return SyncErrorCode.LeaseHeldByOther;
    case "LEASE_MISMATCH":
      return SyncErrorCode.LeaseHeldByOther;
    case "LEASE_EXPIRED":
      return SyncErrorCode.LeaseExpired;
    case "FENCING_TOKEN_INVALID":
      return SyncErrorCode.LeaseFenced;
    case "REVISION_CONFLICT":
      return SyncErrorCode.PublishRejected;
    case "NOT_FOUND":
      return SyncErrorCode.RevisionNotFound;
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return SyncErrorCode.BackendAuthFailed;
    case "VALIDATION_FAILED":
    case "BAD_REQUEST":
      return SyncErrorCode.InvalidInput;
    default:
      return SyncErrorCode.Internal;
  }
}

interface BackendErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export class CoordinationClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private config: CoordinationClientConfig,
    fetchImpl?: FetchLike,
  ) {
    // Default to global fetch (Node 18+ / Electron). Cast through the minimal
    // structural type so tests can inject a stub.
    this.fetchImpl =
      fetchImpl ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));
  }

  /** Replace config (e.g. after settings/secret change) without a new client. */
  updateConfig(config: CoordinationClientConfig): void {
    this.config = config;
  }

  private base(): string {
    return this.config.workerUrl.replace(/\/+$/, "");
  }

  private accessHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.accessClientId) h["CF-Access-Client-Id"] = this.config.accessClientId;
    if (this.config.accessClientSecret) {
      h["CF-Access-Client-Secret"] = this.config.accessClientSecret;
    }
    return h;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; ok: boolean; json: unknown }> {
    if (!this.config.workerUrl) {
      throw syncError(SyncErrorCode.BackendUnreachable, "Sync backend URL not configured");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const res = await this.fetchImpl(`${this.base()}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...this.accessHeaders(),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const raw = await res.text();
      let json: unknown = undefined;
      if (raw.length > 0) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
      }
      return { status: res.status, ok: res.ok, json };
    } catch (err) {
      if (isSyncErrorLike(err)) throw err;
      throw syncError(
        SyncErrorCode.BackendUnreachable,
        `Sync backend unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turn a non-2xx response body into a typed SyncError. */
  private toError(status: number, json: unknown): SyncError {
    const body = (json ?? {}) as BackendErrorBody;
    const code = body.error?.code;
    const message = body.error?.message ?? `backend responded ${status}`;
    if (code) {
      return syncError(mapBackendCode(code), message, { httpStatus: status, backendCode: code });
    }
    if (status === 401 || status === 403) {
      return syncError(
        SyncErrorCode.BackendAuthFailed,
        message === `backend responded ${status}`
          ? "Sync backend rejected credentials — check your Cloudflare Access client id/secret"
          : message,
        { httpStatus: status },
      );
    }
    return syncError(SyncErrorCode.Internal, message, { httpStatus: status });
  }

  /** Unauthenticated liveness probe. Returns true only on 2xx `{status:"ok"}`. */
  async health(): Promise<boolean> {
    try {
      const { ok, json } = await this.request("GET", "/health");
      return ok && (json as { status?: string })?.status === "ok";
    } catch {
      return false;
    }
  }

  /** GET current coordination state. NOT_FOUND → {kind:"not-found"} (revision 0). */
  async getState(profileId: string): Promise<StateResult> {
    const { status, ok, json } = await this.request(
      "GET",
      `/v1/profiles/${encodeURIComponent(profileId)}`,
    );
    if (ok) {
      const state = (json as { state?: BackendState })?.state;
      if (!state) throw syncError(SyncErrorCode.Internal, "malformed state response");
      return { kind: "state", state };
    }
    const err = this.toError(status, json);
    if (err.code === SyncErrorCode.RevisionNotFound) return { kind: "not-found" };
    throw err;
  }

  async acquire(profileId: string, operationId: string): Promise<LeaseResult> {
    const { status, ok, json } = await this.request(
      "POST",
      `/v1/profiles/${encodeURIComponent(profileId)}/acquire`,
      { deviceId: this.config.deviceId, operationId },
    );
    if (!ok) throw this.toError(status, json);
    return json as LeaseResult;
  }

  async renew(
    profileId: string,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): Promise<LeaseResult> {
    const { status, ok, json } = await this.request(
      "POST",
      `/v1/profiles/${encodeURIComponent(profileId)}/renew`,
      { deviceId: this.config.deviceId, leaseId, fencingToken, operationId },
    );
    if (!ok) throw this.toError(status, json);
    return json as LeaseResult;
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
    const { status, ok, json } = await this.request(
      "POST",
      `/v1/profiles/${encodeURIComponent(profileId)}/publish`,
      {
        deviceId: this.config.deviceId,
        leaseId: args.leaseId,
        fencingToken: args.fencingToken,
        operationId: args.operationId,
        expectedRevision: args.expectedRevision,
        latestSnapshotId: args.latestSnapshotId,
      },
    );
    if (!ok) throw this.toError(status, json);
    return json as PublishResult;
  }

  async release(
    profileId: string,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): Promise<ReleaseResult> {
    const { status, ok, json } = await this.request(
      "POST",
      `/v1/profiles/${encodeURIComponent(profileId)}/release`,
      { deviceId: this.config.deviceId, leaseId, fencingToken, operationId },
    );
    if (!ok) throw this.toError(status, json);
    return json as ReleaseResult;
  }
}

function isSyncErrorLike(err: unknown): err is SyncError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}
