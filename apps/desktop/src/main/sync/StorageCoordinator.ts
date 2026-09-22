/**
 * Storage coordinator factory + narrow control-plane interface.
 *
 * This replaces the Worker + Cloudflare Access coordination client with
 * the conditional-write R2/S3 state coordinator from `@multizen/s3-coordinator`.
 * There is NO server-side compute and NO Access service token: correctness
 * rests entirely on atomic conditional object writes against the SAME bucket
 * the Kopia repository lives in, under a SEPARATE control prefix.
 *
 * Design:
 *   - {@link Coordinator} is the narrow interface the SyncController depends on.
 *     Its shape matches the {@link S3Coordinator} public methods (health,
 *     capabilityProbe, getState, acquire, renew, publish, release) so a test
 *     fake can be injected without the SDK.
 *   - {@link StorageCoordinatorFactory} builds ONE {@link S3Coordinator} per
 *     effective config + credential version and caches it. When any relevant
 *     endpoint/region/bucket/control-prefix/path-style/device/timing value or
 *     credential reference/value changes, the cache key changes and the
 *     coordinator is rebuilt lazily on the next `get()`.
 *   - Async creation is race-safe: concurrent `get()` calls for the same key
 *     await a single in-flight build promise; a rebuild for a NEW key supersedes
 *     any stale in-flight build.
 *   - Credentials live ONLY inside the SDK client config (via S3StoreConfig).
 *     Nothing here exposes SDK/client credentials through diagnostics or
 *     serialization — the effective-config fingerprint hashes credential
 *     material rather than storing it, and there is no field carrying the raw
 *     access key / secret / session token.
 */

import { createHash } from "node:crypto";
import type { CapabilityProbeResult } from "@multizen/s3-coordinator";
import {
  S3Coordinator,
  S3ConditionalObjectStore,
  createS3Deps,
  type BackendState,
  type LeaseResult,
  type ListProfilesResult,
  type PublishResult,
  type ReleaseResult,
  type ReviveResult,
  type StateResult,
  type TombstoneResult,
  type S3Deps,
} from "@multizen/s3-coordinator";

/**
 * The narrow control-plane surface the SyncController consumes. Structurally
 * compatible with {@link S3Coordinator}; a fake implementing this interface can
 * be injected in tests.
 */
export interface Coordinator {
  /** Reachability / authorization probe against the backing bucket. */
  health(): Promise<boolean>;
  /**
   * Prove the store enforces conditional writes. `force` re-runs even if a
   * previous probe succeeded and was cached.
   */
  capabilityProbe(force?: boolean): Promise<CapabilityProbeResult>;
  getState(profileId: string): Promise<StateResult>;
  acquire(profileId: string, operationId: string): Promise<LeaseResult>;
  renew(
    profileId: string,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): Promise<LeaseResult>;
  publish(
    profileId: string,
    args: {
      leaseId: string;
      fencingToken: number;
      operationId: string;
      expectedRevision: number;
      latestSnapshotId: string;
    },
  ): Promise<PublishResult>;
  release(
    profileId: string,
    leaseId: string,
    fencingToken: number,
    operationId: string,
  ): Promise<ReleaseResult>;
  /**
   * List every committed, non-tombstoned remote profile under the control
   * prefix. Used by the whole-library bootstrap to discover profiles that
   * exist remotely but are missing (or already present) locally.
   */
  listProfiles(): Promise<ListProfilesResult>;
  /**
   * Write a durable tombstone for a profile (logical deletion). Requires the
   * caller to own an unexpired lease + matching fencing token. Optionally does
   * best-effort strict cleanup of that profile's revision-history objects.
   */
  tombstoneProfile(
    profileId: string,
    args: {
      leaseId: string;
      fencingToken: number;
      operationId: string;
      reason?: string;
      cleanupHistory?: boolean;
    },
  ): Promise<TombstoneResult>;
  /**
   * Revive a previously tombstoned profile into a fresh generation + revision
   * line so a re-enable uploads as a brand-new baseline. Idempotent; a no-op on
   * a live profile.
   */
  reviveProfile(profileId: string, operationId: string): Promise<ReviveResult>;
}

export type {
  BackendState,
  LeaseResult,
  ListProfilesResult,
  PublishResult,
  ReleaseResult,
  ReviveResult,
  StateResult,
  TombstoneResult,
};

/**
 * The effective non-secret coordinator configuration. Everything here is safe
 * to fingerprint/serialize; NO raw credential value ever appears.
 */
export interface CoordinatorConfig {
  endpoint: string;
  region: string;
  bucket: string;
  controlPrefix: string;
  s3ForcePathStyle: boolean;
  deviceId: string;
  leaseTtlMs: number;
  renewalMs: number;
  clockSkewSafetyMs: number;
}

/** Static S3/R2 credentials pulled from the Keychain vault (never persisted). */
export interface CoordinatorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional session token — only forwarded when present. */
  sessionToken?: string;
}

/** Injectable dependencies so tests can bypass the AWS SDK entirely. */
export interface StorageCoordinatorFactoryDeps {
  /**
   * Resolve the AWS SDK adapter. Defaults to the real (dynamically-imported)
   * SDK via {@link createS3Deps}. Injectable for tests.
   */
  loadS3Deps?: () => Promise<S3Deps>;
  /**
   * Build a coordinator directly from an effective config + credentials.
   * Injectable so tests can substitute a fake coordinator without any store.
   * When provided it fully replaces the store/SDK path.
   */
  buildCoordinator?: (
    config: CoordinatorConfig,
    credentials: CoordinatorCredentials,
  ) => Coordinator | Promise<Coordinator>;
}

/**
 * Compute a stable fingerprint for an effective config + credentials. Credential
 * material is HASHED (sha-256), never stored, so two different secrets produce
 * different keys without the key itself carrying a secret. This is the cache
 * key: a change to ANY relevant field (endpoint/region/bucket/control
 * prefix/path-style/device/timings) OR the credential values rebuilds the
 * coordinator.
 */
function fingerprint(config: CoordinatorConfig, creds: CoordinatorCredentials): string {
  const credHash = createHash("sha256")
    .update(creds.accessKeyId)
    .update("\u0000")
    .update(creds.secretAccessKey)
    .update("\u0000")
    .update(creds.sessionToken ?? "")
    .digest("hex");
  const cfg = JSON.stringify({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    controlPrefix: config.controlPrefix,
    s3ForcePathStyle: config.s3ForcePathStyle,
    deviceId: config.deviceId,
    leaseTtlMs: config.leaseTtlMs,
    renewalMs: config.renewalMs,
    clockSkewSafetyMs: config.clockSkewSafetyMs,
  });
  return `${cfg}|${credHash}`;
}

/**
 * Validate + normalize the control prefix. Never empty; never placed inside
 * Kopia's key namespace by default (equality with the Kopia prefix is
 * rejected). Leading/trailing slashes stripped.
 */
export function assertSafeControlPrefix(controlPrefix: string, kopiaPrefix: string): string {
  const normalized = controlPrefix.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (normalized.length === 0) {
    throw new Error("control prefix must be a non-empty, safe key prefix");
  }
  if (/[\u0000]/.test(normalized) || normalized.includes("..")) {
    throw new Error("control prefix contains unsafe characters");
  }
  const kopia = kopiaPrefix.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (kopia.length > 0) {
    // Never nest control objects inside Kopia's internal key namespace.
    if (normalized === kopia || normalized.startsWith(`${kopia}/`)) {
      throw new Error(
        "control prefix must not live inside the backup data prefix",
      );
    }
  }
  return normalized;
}

/**
 * Builds and caches a single {@link Coordinator} per effective config +
 * credential version. Async creation is race-safe.
 */
export class StorageCoordinatorFactory {
  private key: string | null = null;
  private coordinator: Coordinator | null = null;
  private inFlight: { key: string; promise: Promise<Coordinator> } | null = null;
  private depsCache: S3Deps | null = null;

  constructor(private readonly deps: StorageCoordinatorFactoryDeps = {}) {}

  /**
   * Return a coordinator for the given effective config + credentials, rebuilding
   * only when the effective fingerprint changed. Concurrent callers for the same
   * fingerprint share one in-flight build; a build for a new fingerprint
   * supersedes stale in-flight work.
   */
  async get(
    config: CoordinatorConfig,
    credentials: CoordinatorCredentials,
  ): Promise<Coordinator> {
    const key = fingerprint(config, credentials);
    if (this.coordinator && this.key === key) return this.coordinator;
    if (this.inFlight && this.inFlight.key === key) return this.inFlight.promise;

    const promise = this.build(config, credentials).then((coord) => {
      // Only commit if this build is still the most recent request for `key`.
      if (this.inFlight && this.inFlight.key === key) {
        this.coordinator = coord;
        this.key = key;
        this.inFlight = null;
      }
      return coord;
    });
    this.inFlight = { key, promise };
    return promise;
  }

  /** True when a coordinator has been built for `config`+`credentials`. */
  isCurrent(config: CoordinatorConfig, credentials: CoordinatorCredentials): boolean {
    return this.coordinator !== null && this.key === fingerprint(config, credentials);
  }

  /** Drop the cached coordinator so the next `get()` rebuilds. */
  reset(): void {
    this.coordinator = null;
    this.key = null;
    this.inFlight = null;
  }

  private async build(
    config: CoordinatorConfig,
    credentials: CoordinatorCredentials,
  ): Promise<Coordinator> {
    if (this.deps.buildCoordinator) {
      return this.deps.buildCoordinator(config, credentials);
    }
    if (!this.depsCache) {
      const loader = this.deps.loadS3Deps ?? createS3Deps;
      this.depsCache = await loader();
    }
    const store = new S3ConditionalObjectStore(
      {
        bucket: config.bucket,
        region: config.region || undefined,
        endpoint: config.endpoint || undefined,
        forcePathStyle: config.s3ForcePathStyle,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
        },
      },
      this.depsCache,
    );
    return new S3Coordinator(store, {
      deviceId: config.deviceId,
      controlPrefix: config.controlPrefix,
      leaseTtlMs: config.leaseTtlMs,
      renewalMs: config.renewalMs,
      clockSkewSafetyMs: config.clockSkewSafetyMs,
    });
  }
}
