/**
 * SyncController — orchestrates manual two-Mac Cloud Sync on the desktop.
 *
 * Responsibilities:
 *   - hold non-secret config (from settings) + secrets (from the vault),
 *   - talk to the conditional-write S3/R2 state {@link Coordinator} (no Worker,
 *     no Cloudflare Access) built lazily from current config + vault,
 *   - drive Kopia (connect → snapshot / restore) via the adapter factory,
 *   - keep an in-memory lease per profile with auto-renew timers,
 *   - gate profile launches (`beforeLaunch`) and mark profiles dirty,
 *   - preserve unsynced/MCP behavior (only synced profiles are coupled).
 *
 * Design notes:
 *   - The controller NEVER merges Chromium state. On divergence it preserves
 *     both by creating a local conflict copy before a canonical restore.
 *   - Publish only clears `dirty` after the coordinator accepts the revision.
 *   - Release/backup/restore refuse while the profile's Chromium is running.
 *   - Initial coordinator not-found is treated as revision 0.
 *   - Control objects live in the SAME bucket as the Kopia repo but under a
 *     SEPARATE, validated control prefix — never inside Kopia's key namespace.
 *
 * All fs / network / Kopia dependencies are injectable so the controller is
 * testable without Electron.
 */

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Profile } from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import {
  SyncErrorCode,
  isSyncError,
  syncError,
  toManifest,
  assertManifestSafe,
  decideLaunch,
  decidePublish,
  conflictCopyName,
  MANIFEST_VERSION,
  NO_REVISION,
  type SyncError,
} from "@multizen/sync-core";
import {
  atomicSwap,
  sameVolumeSync,
  type KopiaAdapter,
  type KopiaSecrets,
} from "@multizen/kopia-adapter";
import type { AppSettings, SettingsStore, SyncConfig } from "@multizen/settings-store";
import type { CredentialVault } from "./CredentialVault.ts";
import {
  StorageCoordinatorFactory,
  assertSafeControlPrefix,
  type Coordinator,
  type CoordinatorConfig,
  type CoordinatorCredentials,
  type StorageCoordinatorFactoryDeps,
} from "./StorageCoordinator.ts";
import { ProfileQuiescenceGuard, type QuiescenceDriver } from "./ProfileQuiescenceGuard.ts";
import { resolveKopiaBinary, createKopiaAdapter, KOPIA_PINNED_VERSION } from "./kopiaFactory.ts";
import { redact, redactError } from "./redaction.ts";
import type {
  ProfileDiagnosticsView,
  ProfileSyncStatusView,
  RepositoryInitResult,
  SecretKind,
  StorageTestResult,
  SyncConfigView,
  SyncDiagnostics,
  SyncDiagnosticsExport,
  SyncOperationView,
  SyncProgressEvent,
} from "./types.ts";

/** An in-memory lease the controller holds for a profile. */
interface HeldLease {
  profileId: string;
  leaseId: string;
  fencingToken: number;
  expiresAtMs: number;
  renewTimer: NodeJS.Timeout;
  /** True while a synced-owned Chromium is open under this lease. */
  browserOpen: boolean;
}

const SECRET_KINDS: SecretKind[] = ["kopiaPassword", "s3AccessKeyId", "s3SecretAccessKey"];

export interface SyncControllerDeps {
  settingsStore: SettingsStore;
  getSettings: () => AppSettings;
  profileManager: ProfileManager;
  vault: CredentialVault;
  driver: QuiescenceDriver & {
    close(profileId: string): Promise<void>;
  };
  /** Absolute root under which profiles live (for staging same-volume swaps). */
  profilesRoot: string;
  /** Kopia config file path default (under userData). */
  kopiaConfigDefault: string;
  /** process.resourcesPath in packaged builds; undefined in dev. */
  resourcesPath?: string;
  /** App version string (from app.getVersion()), for diagnostics export. */
  appVersion?: string;
  /** Host platform/arch, injectable for tests. Defaults to process values. */
  platform?: string;
  arch?: string;
  /** Existence probe for the resolved Kopia binary. Defaults to fs.existsSync. */
  binExists?: (p: string) => boolean;
  /** Emit a progress/error event to the renderer. */
  emit?: (event: SyncProgressEvent) => void;
  /**
   * Injectable coordinator (tests). When set, it is used verbatim and no
   * storage-coordinator factory is consulted — the controller treats it as the
   * always-current coordinator for every config.
   */
  coordinator?: Coordinator;
  /** Injectable storage-coordinator factory deps (tests). */
  coordinatorFactoryDeps?: StorageCoordinatorFactoryDeps;
  /** Injectable Kopia adapter factory (tests). */
  makeKopia?: (secrets: KopiaSecrets, configFile: string) => KopiaAdapter;
  /** Injectable same-volume check (tests). Defaults to fs statSync device id. */
  sameVolume?: (a: string, b: string) => boolean;
}

export class SyncController {
  private readonly leases = new Map<string, HeldLease>();
  private readonly coordinatorFactory: StorageCoordinatorFactory;
  /** Test-injected coordinator that bypasses the factory entirely. */
  private readonly injectedCoordinator: Coordinator | null;
  private lastStoreHealth: boolean | null = null;
  private lastCapability: { ok: boolean; failedCheck: string | null } | null = null;
  /** Last redacted sync error message (never a secret), for diagnostics. */
  private lastSyncError: string | null = null;
  private disposed = false;

  constructor(private readonly deps: SyncControllerDeps) {
    this.injectedCoordinator = deps.coordinator ?? null;
    this.coordinatorFactory = new StorageCoordinatorFactory(deps.coordinatorFactoryDeps);
  }

  private cfg(): SyncConfig {
    return this.deps.getSettings().sync;
  }

  private emit(event: SyncProgressEvent): void {
    if (event.phase === "error") this.lastSyncError = event.message;
    this.deps.emit?.(event);
  }

  /** All currently-known secret values, for redaction. */
  private async secretValuesForRedaction(): Promise<(string | null)[]> {
    const c = this.cfg();
    return Promise.all([
      this.deps.vault.get(c.kopiaPasswordRef),
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
  }

  /**
   * Build the effective non-secret coordinator config from current settings.
   * Validates + normalizes the control prefix so control objects never nest
   * inside Kopia's key namespace and can never collide with the bucket root.
   */
  private coordinatorConfig(): CoordinatorConfig {
    const c = this.cfg();
    const controlPrefix = assertSafeControlPrefix(c.controlPrefix, c.s3Prefix);
    return {
      endpoint: c.s3Endpoint,
      region: c.s3Region,
      bucket: c.s3Bucket,
      controlPrefix,
      s3ForcePathStyle: c.s3ForcePathStyle,
      deviceId: c.deviceId,
      leaseTtlMs: c.leaseTtlMs,
      renewalMs: c.renewalMs,
      clockSkewSafetyMs: c.clockSkewSafetyMs,
    };
  }

  /** Load the S3/R2 credentials from the vault (never persisted elsewhere). */
  private async coordinatorCredentials(): Promise<CoordinatorCredentials> {
    const c = this.cfg();
    const [accessKeyId, secretAccessKey] = await Promise.all([
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
    if (!accessKeyId || !secretAccessKey) {
      throw syncError(
        SyncErrorCode.InvalidInput,
        "S3/R2 access key id and secret access key are required to coordinate",
      );
    }
    return { accessKeyId, secretAccessKey };
  }

  /**
   * Lazily obtain the current coordinator, rebuilding it whenever the effective
   * config or credential version changes. A test-injected coordinator bypasses
   * the factory. A missing bucket is rejected deterministically BEFORE any
   * credential read so an unconfigured store never spawns SDK work.
   */
  private async coordinator(): Promise<Coordinator> {
    if (this.injectedCoordinator) return this.injectedCoordinator;
    const config = this.coordinatorConfig();
    if (!config.bucket.trim()) {
      throw syncError(
        SyncErrorCode.StorageUnreachable,
        "Storage bucket is not configured — set it before coordinating",
      );
    }
    const credentials = await this.coordinatorCredentials();
    return this.coordinatorFactory.get(config, credentials);
  }

  // ── Config + secrets ───────────────────────────────────────────────────

  configView(): SyncConfigView {
    const c = this.cfg();
    return {
      enabled: c.enabled,
      s3Endpoint: c.s3Endpoint,
      s3Region: c.s3Region,
      s3Bucket: c.s3Bucket,
      s3Prefix: c.s3Prefix,
      controlPrefix: c.controlPrefix,
      s3ForcePathStyle: c.s3ForcePathStyle,
      leaseTtlMs: c.leaseTtlMs,
      renewalMs: c.renewalMs,
      clockSkewSafetyMs: c.clockSkewSafetyMs,
      deviceId: c.deviceId,
      deviceDisplayName: c.deviceDisplayName,
      kopiaConfigPath: c.kopiaConfigPath,
      kopiaBinPath: c.kopiaBinPath,
    };
  }

  /** Update non-secret config. Never accepts secret values. */
  async updateConfig(patch: Partial<SyncConfigView>): Promise<SyncConfigView> {
    // Whitelist non-secret keys only; deviceId is immutable identity.
    const allowed: Partial<SyncConfig> = {};
    if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
    if (typeof patch.s3Endpoint === "string") allowed.s3Endpoint = patch.s3Endpoint.trim();
    if (typeof patch.s3Region === "string") allowed.s3Region = patch.s3Region.trim();
    if (typeof patch.s3Bucket === "string") allowed.s3Bucket = patch.s3Bucket.trim();
    if (typeof patch.s3Prefix === "string") allowed.s3Prefix = patch.s3Prefix.trim();
    if (typeof patch.controlPrefix === "string")
      allowed.controlPrefix = patch.controlPrefix.trim();
    if (typeof patch.s3ForcePathStyle === "boolean")
      allowed.s3ForcePathStyle = patch.s3ForcePathStyle;
    if (typeof patch.leaseTtlMs === "number" && Number.isInteger(patch.leaseTtlMs) && patch.leaseTtlMs > 0)
      allowed.leaseTtlMs = patch.leaseTtlMs;
    if (typeof patch.renewalMs === "number" && Number.isInteger(patch.renewalMs) && patch.renewalMs > 0)
      allowed.renewalMs = patch.renewalMs;
    if (
      typeof patch.clockSkewSafetyMs === "number" &&
      Number.isInteger(patch.clockSkewSafetyMs) &&
      patch.clockSkewSafetyMs > 0
    )
      allowed.clockSkewSafetyMs = patch.clockSkewSafetyMs;
    if (typeof patch.deviceDisplayName === "string")
      allowed.deviceDisplayName = patch.deviceDisplayName.trim() || "This device";
    if (typeof patch.kopiaConfigPath === "string")
      allowed.kopiaConfigPath = patch.kopiaConfigPath.trim();
    if (typeof patch.kopiaBinPath === "string") allowed.kopiaBinPath = patch.kopiaBinPath.trim();
    await this.deps.settingsStore.update({ sync: allowed as SyncConfig });
    // Config changed → the cached coordinator (if any) may be stale; the next
    // coordinator() call rebuilds it lazily when the effective fingerprint
    // differs. Reset defensively so a bucket/prefix change is never missed.
    this.coordinatorFactory.reset();
    return this.configView();
  }

  /** Save a secret to the vault. The value is never persisted elsewhere. */
  async saveSecret(kind: SecretKind, value: string): Promise<void> {
    const ref = this.refForKind(kind);
    if (value.length === 0) {
      await this.deps.vault.delete(ref);
    } else {
      await this.deps.vault.set(ref, value);
    }
    // A credential change invalidates the cached coordinator.
    this.coordinatorFactory.reset();
  }

  async deleteSecret(kind: SecretKind): Promise<void> {
    await this.deps.vault.delete(this.refForKind(kind));
    this.coordinatorFactory.reset();
  }

  /** Report which secrets are present (never their values). */
  async secretsPresent(): Promise<SyncDiagnostics["secretsPresent"]> {
    const c = this.cfg();
    const [kp, ak, sk] = await Promise.all([
      this.deps.vault.has(c.kopiaPasswordRef),
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);
    return {
      kopiaPassword: kp,
      s3AccessKeyId: ak,
      s3SecretAccessKey: sk,
    };
  }

  private refForKind(kind: SecretKind): string {
    const c = this.cfg();
    switch (kind) {
      case "kopiaPassword":
        return c.kopiaPasswordRef;
      case "s3AccessKeyId":
        return c.s3AccessKeyIdRef;
      case "s3SecretAccessKey":
        return c.s3SecretAccessKeyRef;
    }
  }

  /**
   * Test storage coordination: probe store reachability, then run a FORCED
   * conditional-write capability probe, and report whether conditional writes
   * are supported. Refreshes the cached health/capability values for
   * diagnostics. Never throws for a probe failure — it reports it.
   */
  async testStorageCoordination(): Promise<StorageTestResult> {
    const secrets = await this.secretValuesForRedaction();
    let coordinator: Coordinator;
    try {
      coordinator = await this.coordinator();
    } catch (err) {
      // No bucket / missing credentials → surface as an unhealthy, unsupported
      // result rather than throwing across IPC.
      this.lastStoreHealth = false;
      this.lastCapability = { ok: false, failedCheck: "unconfigured" };
      return {
        healthy: false,
        capability: {
          ok: false,
          failedCheck: "unconfigured",
          message: redact(err instanceof Error ? err.message : String(err), secrets),
        },
        conditionalWritesSupported: false,
      };
    }
    const healthy = await coordinator.health();
    this.lastStoreHealth = healthy;
    const probe = await coordinator.capabilityProbe(true);
    this.lastCapability = { ok: probe.ok, failedCheck: probe.failedCheck ?? null };
    return {
      healthy,
      capability: {
        ok: probe.ok,
        failedCheck: probe.failedCheck ?? null,
        message: probe.message ? redact(probe.message, secrets) : null,
      },
      conditionalWritesSupported: healthy && probe.ok,
    };
  }

  async diagnostics(): Promise<SyncDiagnostics> {
    const c = this.cfg();
    const kopiaBin = resolveKopiaBinary({
      overridePath: c.kopiaBinPath,
      resourcesPath: this.deps.resourcesPath,
    });
    return {
      enabled: c.enabled,
      configured: Boolean(c.s3Bucket.trim()),
      secretsPresent: await this.secretsPresent(),
      storeHealthy: this.lastStoreHealth,
      capability: this.lastCapability,
      bucket: c.s3Bucket,
      controlPrefix: c.controlPrefix,
      deviceId: c.deviceId,
      deviceDisplayName: c.deviceDisplayName,
      kopiaBinPath: kopiaBin,
    };
  }

  /**
   * Build a fully-sanitized diagnostics bundle safe to export to disk / share.
   *
   * Hard guarantees (see also the canary redaction tests):
   *   - NO vault contents, repository password, or S3 secret/access keys appear
   *     anywhere.
   *   - NO SDK/client credentials leak (the coordinator/store never expose them,
   *     and this bundle carries only bucket/endpoint/region/prefixes + presence).
   *   - Any journal message is passed through {@link redact} against the live
   *     secret set as defense-in-depth, even though messages are already
   *     redacted at write time.
   *
   * `profileId` limits the export to a single profile; otherwise every
   * sync-enabled profile is included. Coordination owner/lease state is fetched
   * best-effort and omitted (null) on any failure — a diagnostics export must
   * never throw just because the store is unreachable.
   */
  async exportDiagnostics(profileId?: string): Promise<SyncDiagnosticsExport> {
    const c = this.cfg();
    const app = await this.diagnostics();
    const secrets = await this.secretValuesForRedaction();
    const binExists = this.deps.binExists ?? existsSync;
    const kopiaBinPresent = binExists(app.kopiaBinPath);

    const [hasAccessKey, hasSecretKey] = await Promise.all([
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);

    const ids = profileId ? [profileId] : this.syncEnabledProfileIds();
    const profiles: ProfileDiagnosticsView[] = [];
    for (const id of ids) {
      profiles.push(await this.profileDiagnostics(id, secrets));
    }

    return {
      generatedAt: new Date().toISOString(),
      appVersion: this.deps.appVersion ?? "unknown",
      platform: this.deps.platform ?? process.platform,
      arch: this.deps.arch ?? process.arch,
      kopiaPinnedVersion: KOPIA_PINNED_VERSION,
      kopiaBinPresent,
      app,
      storage: {
        bucket: c.s3Bucket,
        endpoint: c.s3Endpoint,
        region: c.s3Region,
        controlPrefix: c.controlPrefix,
        kopiaPrefix: c.s3Prefix,
        credentialsPresent: hasAccessKey && hasSecretKey,
        healthy: this.lastStoreHealth,
        capability: this.lastCapability,
        lastError: this.lastSyncError ? redact(this.lastSyncError, secrets) : null,
      },
      profiles,
    };
  }

  /** Ids of every sync-enabled profile (best-effort; empty if PM lacks a lister). */
  private syncEnabledProfileIds(): string[] {
    const pm = this.deps.profileManager as unknown as {
      list?: () => Array<{ id: string }>;
    };
    const all = typeof pm.list === "function" ? pm.list() : [];
    return all
      .map((p) => p.id)
      .filter((id) => this.deps.profileManager.getSyncState(id)?.syncEnabled === true);
  }

  /** Build one profile's sanitized diagnostics slice. */
  private async profileDiagnostics(
    profileId: string,
    secrets: (string | null)[],
  ): Promise<ProfileDiagnosticsView> {
    const s = this.deps.profileManager.getSyncState(profileId);
    const held = this.leases.get(profileId);

    // Best-effort coordination owner/lease state (never throws, never carries secrets).
    let owner: ProfileDiagnosticsView["owner"] = null;
    if (s?.syncEnabled && this.cfg().s3Bucket.trim()) {
      try {
        const coordinator = await this.coordinator();
        const res = await coordinator.getState(profileId);
        if (res.kind === "state") {
          owner = {
            ownerDeviceId: res.state.ownerDeviceId,
            leaseExpiresAt: res.state.leaseExpiresAt,
            currentRevision: res.state.currentRevision,
            latestSnapshotId: res.state.latestSnapshotId,
            fencingToken: res.state.fencingToken,
          };
        }
      } catch {
        owner = null;
      }
    }

    // Newest journal entry, message re-redacted defensively.
    let lastOperation: SyncOperationView | null = null;
    const pm = this.deps.profileManager as unknown as {
      listSyncOperations?: (id: string, limit?: number) => SyncOperationView[];
    };
    if (typeof pm.listSyncOperations === "function") {
      const ops = pm.listSyncOperations(profileId, 1);
      const op = ops[0];
      if (op) {
        lastOperation = {
          id: op.id,
          kind: op.kind,
          status: op.status,
          fromRevision: op.fromRevision,
          toRevision: op.toRevision,
          snapshotId: op.snapshotId,
          message: op.message ? redact(op.message, secrets) : null,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        };
      }
    }

    return {
      profileId,
      syncEnabled: s?.syncEnabled ?? false,
      dirty: s?.dirty ?? false,
      localRevision: s?.localRevision ?? 0,
      baseRevision: s?.baseRevision ?? 0,
      remoteRevision: s?.remoteRevision ?? 0,
      latestSnapshotId: s?.latestSnapshotId ?? null,
      lastSyncedAt: s?.lastSyncedAt ?? null,
      hasLease: held !== undefined && held.expiresAtMs > Date.now(),
      localLeaseExpiresAt: held?.expiresAtMs ?? null,
      running: this.deps.driver.isRunning(profileId),
      owner,
      lastOperation,
    };
  }

  // ── Per-profile enable/disable + status ──────────────────────────────────

  enable(profileId: string, enabled: boolean): ProfileSyncStatusView {
    const profile = this.deps.profileManager.get(profileId);
    if (!profile) throw syncError(SyncErrorCode.InvalidInput, "profile not found", { profileId });
    this.deps.profileManager.upsertSyncState({ profileId, syncEnabled: enabled });
    return this.status(profileId);
  }

  status(profileId: string): ProfileSyncStatusView {
    const s = this.deps.profileManager.getSyncState(profileId);
    const held = this.leases.get(profileId);
    return {
      profileId,
      syncEnabled: s?.syncEnabled ?? false,
      dirty: s?.dirty ?? false,
      localRevision: s?.localRevision ?? 0,
      baseRevision: s?.baseRevision ?? 0,
      remoteRevision: s?.remoteRevision ?? 0,
      latestSnapshotId: s?.latestSnapshotId ?? null,
      lastSyncedAt: s?.lastSyncedAt ?? null,
      hasLease: held !== undefined && held.expiresAtMs > Date.now(),
      leaseExpiresAt: held?.expiresAtMs ?? null,
      running: this.deps.driver.isRunning(profileId),
    };
  }

  /** Conservatively mark a sync-enabled profile dirty (before writable launch). */
  markDirty(profileId: string): void {
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) return;
    if (!s.dirty) this.deps.profileManager.markSyncDirty(profileId, true);
  }

  // ── Launch gate ──────────────────────────────────────────────────────────

  /**
   * Called before a launch. For unsynced profiles this is a no-op (returns
   * `allow`). For synced profiles it fetches remote state and applies the
   * sync-core launch decision:
   *   - `launch`             → allow (local current or only-local-dirty)
   *   - `restore-then-launch`→ restore latest, then allow
   *   - `conflict`           → refuse; the user must resolve (Restore w/ keep-local)
   *   - `blocked`            → refuse with the structured error
   *
   * Marks the profile dirty on allow (writable launch coming).
   */
  async beforeLaunch(profileId: string): Promise<void> {
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) return; // unsynced → unchanged behavior

    // Single-writer invariant: a writable launch of a synced profile REQUIRES
    // an owned, unexpired in-memory lease. This is validated BEFORE any remote
    // fetch or conflict/restore decision so a device without ownership can
    // never mutate the profile's Chromium state.
    this.requireOwnedLease(profileId);

    const remote = await this.fetchRemoteRevision(profileId);

    const decision = decideLaunch(
      {
        profileId,
        syncEnabled: s.syncEnabled,
        localRevision: s.localRevision,
        baseRevision: s.baseRevision,
        remoteRevision: remote.revision,
        dirty: s.dirty,
        latestSnapshotId: s.latestSnapshotId,
        lastSyncedAt: s.lastSyncedAt,
      },
      remote.revision,
    );

    // Persist best-known remote revision.
    this.deps.profileManager.updateSyncState(profileId, { remoteRevision: remote.revision });

    switch (decision.action) {
      case "launch":
        this.markDirty(profileId);
        return;
      case "restore-then-launch":
        // Keep-local is safe here: decideLaunch only returns this action when
        // the profile is NOT dirty, so there is no local state to preserve.
        await this.restoreLatest(profileId, { keepLocalAsConflict: false });
        this.markDirty(profileId);
        return;
      case "conflict":
        throw syncError(
          SyncErrorCode.ConflictDetected,
          "Local and remote diverged — resolve the conflict before launching",
          { baseRevision: decision.baseRevision, remoteRevision: decision.remoteRevision },
        );
      case "blocked":
        throw decision.error;
    }
  }

  /**
   * Assert this device currently owns an unexpired in-memory lease for the
   * profile. Missing lease → deterministic {@link SyncErrorCode.LeaseHeldByOther}.
   * Expired lease → {@link SyncErrorCode.LeaseExpired} and the stale lease is
   * dropped (its renew timer cleared) so it can never be reused. Returns the
   * validated lease on success.
   */
  private requireOwnedLease(profileId: string): HeldLease {
    const held = this.leases.get(profileId);
    if (!held) {
      throw syncError(
        SyncErrorCode.LeaseHeldByOther,
        "Acquire a lease before launching this synced profile",
        { profileId },
      );
    }
    if (held.expiresAtMs <= Date.now()) {
      this.dropLease(profileId);
      throw syncError(
        SyncErrorCode.LeaseExpired,
        "The lease for this synced profile has expired — acquire it again",
        { profileId },
      );
    }
    return held;
  }

  // ── Coordination: acquire / renew / release ──────────────────────────────

  private async fetchRemoteRevision(
    profileId: string,
  ): Promise<{ revision: number; latestSnapshotId: string | null }> {
    const coordinator = await this.coordinator();
    const res = await coordinator.getState(profileId);
    if (res.kind === "not-found") {
      return { revision: NO_REVISION, latestSnapshotId: null };
    }
    return {
      revision: res.state.currentRevision,
      latestSnapshotId: res.state.latestSnapshotId,
    };
  }

  async acquire(profileId: string): Promise<ProfileSyncStatusView> {
    await this.requireEnabled(profileId);
    const coordinator = await this.coordinator();
    this.emit({ profileId, phase: "acquiring", message: "Acquiring lease…" });
    const result = await coordinator.acquire(profileId, this.newOperationId());
    this.installLease(profileId, {
      leaseId: result.lease.leaseId,
      fencingToken: result.lease.fencingToken,
      expiresAtMs: result.lease.leaseExpiresAt,
      renewalMs: result.lease.recommendedRenewalMs,
    });
    // Record best-known remote revision from acquire's state.
    this.deps.profileManager.updateSyncState(profileId, {
      remoteRevision: result.state.currentRevision,
    });
    this.emit({ profileId, phase: "done", message: "Lease acquired" });
    return this.status(profileId);
  }

  async release(profileId: string): Promise<ProfileSyncStatusView> {
    // Refuse if Chromium still running under this lease.
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(
        SyncErrorCode.BrowserStillRunning,
        "Close the browser before releasing the lease",
        { profileId },
      );
    }
    const held = this.leases.get(profileId);
    if (!held) return this.status(profileId);
    const coordinator = await this.coordinator();
    this.emit({ profileId, phase: "releasing", message: "Releasing lease…" });
    try {
      await coordinator.release(
        profileId,
        held.leaseId,
        held.fencingToken,
        this.newOperationId(),
      );
    } finally {
      this.dropLease(profileId);
    }
    this.emit({ profileId, phase: "done", message: "Lease released" });
    return this.status(profileId);
  }

  private installLease(
    profileId: string,
    lease: { leaseId: string; fencingToken: number; expiresAtMs: number; renewalMs: number },
  ): void {
    this.dropLease(profileId);
    const renewMs = Math.max(3_000, lease.renewalMs);
    const timer = setInterval(() => {
      void this.renewLease(profileId);
    }, renewMs);
    if (typeof timer.unref === "function") timer.unref();
    this.leases.set(profileId, {
      profileId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expiresAtMs: lease.expiresAtMs,
      renewTimer: timer,
      browserOpen: false,
    });
  }

  private dropLease(profileId: string): void {
    const held = this.leases.get(profileId);
    if (!held) return;
    clearInterval(held.renewTimer);
    this.leases.delete(profileId);
  }

  private async renewLease(profileId: string): Promise<void> {
    const held = this.leases.get(profileId);
    if (!held) return;
    try {
      const coordinator = await this.coordinator();
      const result = await coordinator.renew(
        profileId,
        held.leaseId,
        held.fencingToken,
        this.newOperationId(),
      );
      held.expiresAtMs = result.lease.leaseExpiresAt;
      held.fencingToken = result.lease.fencingToken;
    } catch (err) {
      // Lease renewal lost: conservatively close any owned synced browser and
      // invalidate the lease so a stale owner can't publish.
      await this.onLeaseLost(profileId, err);
    }
  }

  /** Invoked on renewal loss or power suspend. Closes owned synced browsers. */
  async onLeaseLost(profileId: string, err?: unknown): Promise<void> {
    const held = this.leases.get(profileId);
    if (!held) return;
    this.dropLease(profileId);
    if (this.deps.driver.isRunning(profileId)) {
      await this.deps.driver.close(profileId).catch(() => {});
    }
    const secrets = await this.secretValuesForRedaction();
    this.emit({
      profileId,
      phase: "error",
      message: err
        ? redact(`Lease lost: ${redactError(err, secrets)}`, secrets)
        : "Lease lost; browser closed",
    });
  }

  /** On OS power suspend/resume, drop all leases and close owned synced browsers. */
  async onPowerSuspend(): Promise<void> {
    const ids = [...this.leases.keys()];
    for (const id of ids) {
      await this.onLeaseLost(id);
    }
  }

  // ── First-run repository initialization ──────────────────────────────────

  /**
   * Explicitly create (`kopia repository create`) the S3/R2 repository this
   * device is configured for. This is a FIRST-RUN, one-time operation for the
   * primary device only — it MUST NOT be run on a second device (Mac B), which
   * connects to the existing repository implicitly via backup/restore.
   *
   * Uses the same vault-loaded secrets, repository target, config path, binary
   * resolver, redaction and progress handling as backup/restore, and calls
   * {@link KopiaAdapter.createRepository} exactly once. Returns deterministic
   * {@link SyncError}s and never surfaces a secret value.
   *
   * Ordering guarantees:
   *   - Missing/invalid credentials (no Kopia password) fail BEFORE any Kopia
   *     process is spawned (loadKopiaSecrets throws first).
   *   - An unset S3 bucket is rejected up-front with a deterministic error.
   */
  async initializeRepository(): Promise<RepositoryInitResult> {
    const c = this.cfg();
    const secrets = await this.secretValuesForRedaction();

    // Deterministic, secret-free precondition: a target bucket is required.
    if (!c.s3Bucket.trim()) {
      const err = syncError(
        SyncErrorCode.InvalidInput,
        "S3/R2 bucket is not configured — set it before initializing the repository",
      );
      this.emit({ profileId: "", phase: "error", message: err.message });
      throw err;
    }

    try {
      // Load secrets first so missing credentials fail before spawning Kopia.
      // makeKopiaFor → loadKopiaSecrets throws InvalidInput when the Kopia
      // repository password is not set, guaranteeing createRepository is never
      // invoked without credentials.
      const kopia = await this.makeKopiaFor("");
      this.emit({
        profileId: "",
        phase: "initializing",
        message: "Creating Kopia repository…",
      });
      // Create the repository exactly once. Connect stays implicit in
      // backup/restore, so we do NOT connect here.
      await kopia.createRepository(this.repoTarget());
      this.emit({ profileId: "", phase: "done", message: "Repository created" });
      return {
        created: true,
        target: {
          bucket: c.s3Bucket,
          endpoint: c.s3Endpoint,
          region: c.s3Region,
          prefix: c.s3Prefix,
        },
      };
    } catch (err) {
      this.emit({ profileId: "", phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  // ── Backup + publish ─────────────────────────────────────────────────────

  /**
   * Snapshot the profile's data dir and publish a new revision. Requires:
   *   - sync enabled, profile clean-or-dirty (dirty is the normal case),
   *   - browser NOT running,
   *   - an owned, unexpired lease.
   * Only clears `dirty` after the backend accepts the commit.
   */
  async backupAndPublish(profileId: string): Promise<ProfileSyncStatusView> {
    const profile = await this.requireEnabled(profileId);
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(
        SyncErrorCode.BrowserStillRunning,
        "Close the browser before backing up",
        { profileId },
      );
    }
    const held = this.leases.get(profileId);
    if (!held || held.expiresAtMs <= Date.now()) {
      throw syncError(SyncErrorCode.LeaseHeldByOther, "Acquire a lease before publishing", {
        profileId,
      });
    }

    const state = this.deps.profileManager.getSyncState(profileId);
    const op = this.deps.profileManager.recordSyncOperation({
      profileId,
      kind: "publish",
      status: "running",
      fromRevision: state?.baseRevision ?? 0,
    });
    const secrets = await this.secretValuesForRedaction();
    try {
      // Write the sanitized manifest next to the profile data.
      await this.writeManifest(profile);

      const kopia = await this.makeKopiaFor(profileId);
      this.emit({ profileId, phase: "snapshotting", message: "Creating snapshot…" });
      await kopia.connect(this.repoTarget());
      // Validated, non-secret correlation tags on the snapshot. Values are
      // constrained to [A-Za-z0-9._-] by the adapter (validateTags); we sanitize
      // here too so a stray character can't reject the whole backup. baseRevision
      // is stringified; operationId reuses the journal op id.
      const snapshotJson = await kopia.snapshot(profileId, profile.dataDir, {
        profileId: sanitizeTagValue(profileId),
        deviceId: sanitizeTagValue(this.cfg().deviceId),
        baseRevision: String(state?.baseRevision ?? 0),
        operationId: sanitizeTagValue(op.id),
      });
      const snapshotId = extractSnapshotId(snapshotJson);
      if (!snapshotId) {
        throw syncError(SyncErrorCode.SnapshotIntegrityFailed, "could not extract snapshot id");
      }

      // Publish with expectedRevision + fencing token.
      const coordinator = await this.coordinator();
      const remoteState = await coordinator.getState(profileId);
      const remote =
        remoteState.kind === "not-found"
          ? { revision: NO_REVISION, latestSnapshotId: null as string | null }
          : {
              revision: remoteState.state.currentRevision,
              latestSnapshotId: remoteState.state.latestSnapshotId,
            };

      // Enforce the "never merge / on divergence keep both" invariant on the
      // direct Backup&Publish path (not just the launch gate): if the remote
      // advanced past this device's base, refuse and let the user resolve via
      // "Restore & keep local as conflict copy". Uses the same pure policy the
      // launch/close paths use (unit-tested in sync-core).
      const decision = decidePublish(
        {
          profileId,
          syncEnabled: state?.syncEnabled ?? true,
          localRevision: state?.localRevision ?? 0,
          baseRevision: state?.baseRevision ?? 0,
          remoteRevision: remote.revision,
          dirty: state?.dirty ?? false,
          latestSnapshotId: state?.latestSnapshotId ?? null,
          lastSyncedAt: state?.lastSyncedAt ?? null,
        },
        remote.revision,
        {
          browserExited: !this.deps.driver.isRunning(profileId),
          lease: {
            profileId,
            ownerDeviceId: this.cfg().deviceId,
            expiresAtMs: held.expiresAtMs,
            fencingToken: held.fencingToken,
          },
          nowMs: Date.now(),
          deviceId: this.cfg().deviceId,
        },
      );
      if (decision.action === "blocked") throw decision.error;

      this.emit({ profileId, phase: "publishing", message: "Publishing revision…" });
      const published = await coordinator.publish(profileId, {
        leaseId: held.leaseId,
        fencingToken: held.fencingToken,
        operationId: this.newOperationId(),
        // CAS anchor is this device's base revision — a concurrent peer publish
        // surfaces as REVISION_CONFLICT instead of silently fast-forwarding.
        expectedRevision: state?.baseRevision ?? 0,
        latestSnapshotId: snapshotId,
      });

      // Only NOW clear dirty — the commit is accepted.
      this.deps.profileManager.updateSyncState(profileId, {
        dirty: false,
        localRevision: published.revision,
        baseRevision: published.revision,
        remoteRevision: published.revision,
        latestSnapshotId: snapshotId,
        lastSyncedAt: new Date().toISOString(),
      });
      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "succeeded",
        toRevision: published.revision,
        snapshotId,
      });
      this.emit({ profileId, phase: "done", message: `Published revision ${published.revision}` });
      return this.status(profileId);
    } catch (err) {
      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "failed",
        message: redactError(err, secrets),
      });
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────

  /**
   * Restore the latest remote snapshot into same-volume staging and atomically
   * swap it into the profile's data dir, rolling back on failure. When
   * `keepLocalAsConflict` is set and local state is dirty, the current local
   * data is first preserved as a new unsynced conflict-copy profile.
   */
  async restoreLatest(
    profileId: string,
    opts: { keepLocalAsConflict: boolean },
  ): Promise<ProfileSyncStatusView> {
    const profile = await this.requireEnabled(profileId);
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(
        SyncErrorCode.BrowserStillRunning,
        "Close the browser before restoring",
        { profileId },
      );
    }

    // Single-writer invariant: restore mutates local state, so it REQUIRES an
    // owned, unexpired lease. Validated before any remote fetch or filesystem
    // work. Expired leases are dropped and surface deterministically.
    this.requireOwnedLease(profileId);

    const state = this.deps.profileManager.getSyncState(profileId);

    // Never silently overwrite dirty local state. A normal restore
    // (keepLocalAsConflict=false) over a dirty profile would destroy unpushed
    // local edits — refuse it and force the caller to explicitly preserve
    // local as a conflict copy (keepLocalAsConflict=true).
    if (state?.dirty && !opts.keepLocalAsConflict) {
      throw syncError(
        SyncErrorCode.ConflictDetected,
        "Local profile has unpublished changes — restore with keep-local-as-conflict to preserve them",
        { profileId },
      );
    }

    const remote = await this.fetchRemoteRevision(profileId);
    if (remote.revision === NO_REVISION || !remote.latestSnapshotId) {
      throw syncError(SyncErrorCode.RevisionNotFound, "no remote snapshot to restore", {
        profileId,
      });
    }

    const op = this.deps.profileManager.recordSyncOperation({
      profileId,
      kind: "restore",
      status: "running",
      toRevision: remote.revision,
    });
    const secrets = await this.secretValuesForRedaction();

    // Rollback bookkeeping. Populated as the operation progresses so the catch
    // block can undo exactly what was done and no more.
    let stagingDir: string | null = null;
    let backupDir: string | null = null;
    let swapped = false; // live dir has been replaced by staging
    let conflictId: string | null = null; // conflict copy DB row, if created
    const prevState = state ? { ...state } : null;

    try {
      // Preserve divergent dirty local state as a conflict copy first. Track
      // its id so we can roll it back if the canonical restore later fails.
      if (opts.keepLocalAsConflict && state?.dirty) {
        conflictId = await this.preserveConflictCopy(
          profile,
          state.baseRevision,
          remote.revision,
        );
      }

      const kopia = await this.makeKopiaFor(profileId);
      await kopia.connect(this.repoTarget());

      // Stage on the same volume as the live dir so the swap is atomic.
      const stamp = Date.now();
      stagingDir = join(dirname(profile.dataDir), `.restore-${profileId}-${stamp}`);
      backupDir = join(dirname(profile.dataDir), `.backup-${profileId}-${stamp}`);
      const sameVol = this.deps.sameVolume ?? sameVolumeSync;
      await fsp.mkdir(stagingDir, { recursive: true });
      if (!sameVol(stagingDir, profile.dataDir)) {
        throw syncError(
          SyncErrorCode.Internal,
          "staging dir is not on the same volume as the profile",
        );
      }

      this.emit({ profileId, phase: "restoring", message: "Restoring snapshot…" });
      await kopia.restore(profileId, remote.latestSnapshotId, stagingDir);

      // Validate the restored manifest BEFORE it becomes the live directory.
      const manifest = await this.readManifestFrom(stagingDir);
      this.validateRestoredManifest(manifest, profileId);

      // Swap staging into the live dir; the previous live dir is retained at
      // backupDir. From here the backup is our rollback anchor and is NOT
      // deleted until BOTH the swap and the local DB update succeed.
      await atomicSwap({ stagingDir, liveDir: profile.dataDir, backupDir });
      swapped = true;
      // Staging no longer exists (renamed into live) — nothing to clean there.
      stagingDir = null;

      // Local sync DB update. If this throws, the catch block restores the
      // original live dir from backup so the profile is left byte-identical.
      this.deps.profileManager.updateSyncState(profileId, {
        dirty: false,
        localRevision: remote.revision,
        baseRevision: remote.revision,
        remoteRevision: remote.revision,
        latestSnapshotId: remote.latestSnapshotId,
        lastSyncedAt: new Date().toISOString(),
      });

      // BOTH the swap and DB update succeeded → the operation is durable.
      // Only now discard the backup (best-effort).
      if (backupDir) await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      backupDir = null;

      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "succeeded",
        snapshotId: remote.latestSnapshotId,
      });
      this.emit({ profileId, phase: "done", message: `Restored revision ${remote.revision}` });
      return this.status(profileId);
    } catch (err) {
      // ── Full rollback: leave on-disk data and the DB/profile set unchanged.
      // 1) If we swapped, restore the original live dir from backup.
      if (swapped && backupDir) {
        try {
          await fsp.rm(profile.dataDir, { recursive: true, force: true }).catch(() => {});
          await fsp.rename(backupDir, profile.dataDir);
          backupDir = null;
        } catch {
          // If restore-from-backup fails the original data still lives at
          // backupDir; surface it rather than silently discarding it.
        }
        // Revert the local sync-state row to its pre-restore values (in case
        // the DB update partially applied before failing).
        if (prevState) {
          this.deps.profileManager.updateSyncState(profileId, {
            dirty: prevState.dirty,
            localRevision: prevState.localRevision,
            baseRevision: prevState.baseRevision,
            remoteRevision: prevState.remoteRevision,
            latestSnapshotId: prevState.latestSnapshotId,
            lastSyncedAt: prevState.lastSyncedAt,
          });
        }
      }
      // 2) Delete any conflict copy we created so the whole op rolls back.
      if (conflictId) {
        try {
          this.deps.profileManager.delete(conflictId);
        } catch {
          /* best-effort */
        }
      }
      // 3) Always clean staging (unless it was renamed into live already).
      if (stagingDir) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }

      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "failed",
        message: redactError(err, secrets),
      });
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  /**
   * Connect an existing remote profile (by its sync id) to this device.
   * Restores the latest snapshot into a fresh profile whose metadata comes
   * from the sanitized manifest, then inserts it via `insertImported`.
   */
  async connectExisting(profileId: string): Promise<{ profileId: string }> {
    // Path-traversal defense: the profile id becomes a single directory
    // segment under profilesRoot. Reject anything that is not a safe segment
    // BEFORE touching the filesystem, the backend, or the DB.
    assertSafePathSegment(profileId);

    if (this.deps.profileManager.get(profileId)) {
      throw syncError(SyncErrorCode.InvalidInput, "a local profile with that id already exists", {
        profileId,
      });
    }

    const coordinator = await this.coordinator();
    const remoteState = await coordinator.getState(profileId);
    const remote =
      remoteState.kind === "not-found"
        ? { revision: NO_REVISION, latestSnapshotId: null as string | null }
        : {
            revision: remoteState.state.currentRevision,
            latestSnapshotId: remoteState.state.latestSnapshotId,
          };
    if (remote.revision === NO_REVISION || !remote.latestSnapshotId) {
      throw syncError(SyncErrorCode.RevisionNotFound, "no remote snapshot for that id", {
        profileId,
      });
    }

    const secrets = await this.secretValuesForRedaction();
    const dataDir = join(this.deps.profilesRoot, profileId);
    const stagingDir = join(this.deps.profilesRoot, `.connect-${profileId}-${Date.now()}`);

    // Never destroy an unexpected pre-existing final data dir — a stray dir
    // there is not ours to reclaim. Refuse rather than rm -rf it.
    if (existsSync(dataDir)) {
      throw syncError(
        SyncErrorCode.LocalStateCorrupt,
        "target profile data directory already exists on disk — refusing to overwrite",
        { profileId },
      );
    }

    // Acquire the coordination lease BEFORE any download/restore so this device
    // is the single writer for the whole pairing. Install auto-renewal so a long
    // restore can't outlive the lease.
    this.emit({ profileId, phase: "acquiring", message: "Acquiring lease…" });
    const acquired = await coordinator.acquire(profileId, this.newOperationId());
    this.installLease(profileId, {
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
      expiresAtMs: acquired.lease.leaseExpiresAt,
      renewalMs: acquired.lease.recommendedRenewalMs,
    });

    // Rollback bookkeeping.
    let installed = false; // staging renamed into final dataDir
    let op: { id: string } | null = null; // journal row, created only after profile row exists

    try {
      const kopia = await this.makeKopiaFor(profileId);
      await kopia.connect(this.repoTarget());
      await fsp.mkdir(stagingDir, { recursive: true });
      this.emit({ profileId, phase: "restoring", message: "Restoring snapshot…" });
      await kopia.restore(profileId, remote.latestSnapshotId, stagingDir);

      // Read + structurally validate the sanitized manifest the snapshot
      // carries. Reject malformed/mismatched manifests before final install.
      const manifest = await this.readManifestFrom(stagingDir);
      this.validateRestoredManifest(manifest, profileId);

      // Move staging into the final data dir (fresh install; guarded above so
      // no live dir exists — we never rm the final dir).
      await fsp.rename(stagingDir, dataDir);
      installed = true;

      const now = new Date().toISOString();
      const profile: Profile = {
        id: profileId,
        name: manifest.name as string,
        notes: manifest.notes as string | undefined,
        tags: (manifest.tags as string[]) ?? [],
        // Proxy from manifest carries no credentials; user re-enters them.
        proxy: manifestProxyToConfig(manifest.proxy),
        fingerprint: manifest.fingerprint as Profile["fingerprint"],
        extensions: [],
        icon: manifest.icon as string | undefined,
        startUrl: manifest.startUrl as string | undefined,
        searchProvider: manifest.searchProvider as string | undefined,
        dataDir,
        createdAt: (manifest.createdAt as string) ?? now,
        updatedAt: now,
        proxyCountry: manifest.proxyCountry as string | undefined,
      };

      // Insert the profile row + sync state FIRST. Only after a row exists can
      // we safely journal a sync operation (sync_operations has an FK to
      // profiles(id)); recording earlier would raise a FOREIGN KEY violation.
      this.deps.profileManager.insertImported(profile);
      this.deps.profileManager.upsertSyncState({
        profileId,
        syncEnabled: true,
        localRevision: remote.revision,
        baseRevision: remote.revision,
        remoteRevision: remote.revision,
        dirty: false,
        latestSnapshotId: remote.latestSnapshotId,
        lastSyncedAt: now,
      });

      // Now the row exists → record the successful restore operation.
      op = this.deps.profileManager.recordSyncOperation({
        profileId,
        kind: "restore",
        status: "succeeded",
        toRevision: remote.revision,
        snapshotId: remote.latestSnapshotId,
      });

      this.emit({ profileId, phase: "done", message: "Connected existing profile" });
      return { profileId };
    } catch (err) {
      // ── Rollback. Clean staging, remove a newly-installed dir, and release
      // the lease we acquired so no ownership or on-disk data leaks.
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (installed) {
        // Final rename succeeded but DB insert/upsert failed — remove the dir
        // we installed so the whole pairing rolls back atomically.
        await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
      }
      // Best-effort release + drop the acquired lease.
      await this.releaseAndDropLease(profileId).catch(() => {});
      // Journal the failure only if a profile row exists (op set means it did).
      if (op) {
        this.deps.profileManager.updateSyncOperation(op.id, {
          status: "failed",
          message: redactError(err, secrets),
        });
      }
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  /** Best-effort remote release of an owned lease, then drop it locally. */
  private async releaseAndDropLease(profileId: string): Promise<void> {
    const held = this.leases.get(profileId);
    if (!held) return;
    try {
      const coordinator = await this.coordinator();
      await coordinator.release(
        profileId,
        held.leaseId,
        held.fencingToken,
        this.newOperationId(),
      );
    } finally {
      this.dropLease(profileId);
    }
  }

  /**
   * Preserve the current (dirty, divergent) local data as a new UNSYNCED
   * conflict-copy profile before a canonical restore overwrites it. Copies the
   * live data dir into the conflict profile's dataDir with rollback on failure.
   */
  private async preserveConflictCopy(
    source: Profile,
    baseRevision: number,
    remoteRevision: number,
  ): Promise<string> {
    const conflictId = randomUUID();
    const conflictName = conflictCopyName(source.name, this.cfg().deviceDisplayName);
    const conflictDataDir = join(this.deps.profilesRoot, conflictId);
    // Copy live data into the conflict dir first (so the DB row always points
    // at populated data). Roll back the dir on any failure.
    try {
      await fsp.cp(source.dataDir, conflictDataDir, { recursive: true });
    } catch (err) {
      await fsp.rm(conflictDataDir, { recursive: true, force: true }).catch(() => {});
      throw syncError(
        SyncErrorCode.Internal,
        `failed to preserve local state as conflict copy: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      this.deps.profileManager.insertConflictProfile({
        source,
        conflictId,
        conflictName,
        dataDir: conflictDataDir,
        baseRevision,
        remoteRevision,
      });
    } catch (err) {
      // DB insert failed → roll back the copied dir so we don't orphan it.
      await fsp.rm(conflictDataDir, { recursive: true, force: true }).catch(() => {});
      throw normalizeError(err);
    }
    return conflictId;
  }

  // ── Kopia + manifest helpers ─────────────────────────────────────────────

  private async makeKopiaFor(_profileId: string): Promise<KopiaAdapter> {
    const c = this.cfg();
    const secrets = await this.loadKopiaSecrets();
    const configFile = c.kopiaConfigPath.trim() || this.deps.kopiaConfigDefault;
    if (this.deps.makeKopia) return this.deps.makeKopia(secrets, configFile);
    const bin = resolveKopiaBinary({
      overridePath: c.kopiaBinPath,
      resourcesPath: this.deps.resourcesPath,
    });
    const guard = new ProfileQuiescenceGuard({
      driver: this.deps.driver,
      resolveDataDir: (id) => this.deps.profileManager.get(id)?.dataDir ?? null,
    });
    return createKopiaAdapter({ bin, configFile, secrets, guard });
  }

  private async loadKopiaSecrets(): Promise<KopiaSecrets> {
    const c = this.cfg();
    const [password, accessKey, secretKey] = await Promise.all([
      this.deps.vault.get(c.kopiaPasswordRef),
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
    if (!password) {
      throw syncError(SyncErrorCode.InvalidInput, "Kopia repository password is not set");
    }
    return {
      kopiaPassword: password,
      awsAccessKeyId: accessKey ?? undefined,
      awsSecretAccessKey: secretKey ?? undefined,
    };
  }

  private repoTarget() {
    const c = this.cfg();
    return {
      kind: "s3" as const,
      bucket: c.s3Bucket,
      endpoint: c.s3Endpoint || undefined,
      region: c.s3Region || undefined,
      prefix: c.s3Prefix || undefined,
    };
  }

  /** Write the sanitized manifest into `<dataDir>/.multizen-sync/profile-manifest.json`. */
  private async writeManifest(profile: Profile): Promise<void> {
    const manifest = assertManifestSafe(
      toManifest({
        id: profile.id,
        name: profile.name,
        notes: profile.notes,
        tags: profile.tags,
        proxy: profile.proxy,
        fingerprint: profile.fingerprint,
        icon: profile.icon,
        startUrl: profile.startUrl,
        searchProvider: profile.searchProvider,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        proxyCountry: profile.proxyCountry,
        // dataDir intentionally omitted (absolute path is machine-local).
      }),
    );
    const dir = join(profile.dataDir, ".multizen-sync");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, "profile-manifest.json"), JSON.stringify(manifest, null, 2));
  }

  private async readManifestFrom(rootDir: string): Promise<Record<string, unknown>> {
    const p = join(rootDir, ".multizen-sync", "profile-manifest.json");
    if (!existsSync(p)) {
      throw syncError(SyncErrorCode.LocalStateCorrupt, "restored snapshot has no manifest");
    }
    const raw = await fsp.readFile(p, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw syncError(SyncErrorCode.LocalStateCorrupt, "restored manifest is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw syncError(SyncErrorCode.LocalStateCorrupt, "restored manifest is not an object");
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Structurally validate a restored manifest and re-run {@link assertManifestSafe}
   * before it can seed a real profile. Rejects malformed or mismatched
   * manifests deterministically so a tampered/foreign snapshot can never be
   * installed. Requirements:
   *   - manifestVersion equals the supported {@link MANIFEST_VERSION},
   *   - id EXACTLY equals the requested profileId,
   *   - name is a required non-empty string,
   *   - tags is an array of strings,
   *   - createdAt/updatedAt (when present) are valid ISO timestamps,
   *   - fingerprint is a non-null object,
   *   - no forbidden fields (password/username/dataDir) anywhere.
   */
  private validateRestoredManifest(
    manifest: Record<string, unknown>,
    expectedProfileId: string,
  ): void {
    const fail = (why: string): never => {
      throw syncError(SyncErrorCode.LocalStateCorrupt, `invalid restored manifest: ${why}`, {
        profileId: expectedProfileId,
      });
    };

    if (manifest.manifestVersion !== MANIFEST_VERSION) {
      fail(`unsupported manifestVersion ${String(manifest.manifestVersion)}`);
    }
    if (typeof manifest.id !== "string" || manifest.id !== expectedProfileId) {
      fail(`id does not match requested profile (${String(manifest.id)})`);
    }
    if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
      fail("name must be a non-empty string");
    }
    if (
      !Array.isArray(manifest.tags) ||
      !manifest.tags.every((t) => typeof t === "string")
    ) {
      fail("tags must be an array of strings");
    }
    if (
      manifest.fingerprint === null ||
      typeof manifest.fingerprint !== "object" ||
      Array.isArray(manifest.fingerprint)
    ) {
      fail("fingerprint must be an object");
    }
    for (const key of ["createdAt", "updatedAt"] as const) {
      const v = manifest[key];
      if (v !== undefined) {
        if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
          fail(`${key} must be a valid ISO timestamp`);
        }
      }
    }
    for (const key of ["notes", "icon", "startUrl", "searchProvider", "proxyCountry"] as const) {
      if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
        fail(`${key} must be a string when present`);
      }
    }
    // Defense-in-depth: reject any forbidden/secret-bearing field (mirrors the
    // write-time guarantee and blocks a tampered manifest carrying credentials).
    assertManifestSafe(manifest as unknown as Parameters<typeof assertManifestSafe>[0]);
  }

  // ── Misc ─────────────────────────────────────────────────────────────────

  private async requireEnabled(profileId: string): Promise<Profile> {
    const profile = this.deps.profileManager.get(profileId);
    if (!profile) throw syncError(SyncErrorCode.InvalidInput, "profile not found", { profileId });
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) {
      throw syncError(SyncErrorCode.SyncDisabled, "sync is not enabled for this profile", {
        profileId,
      });
    }
    return profile;
  }

  private newOperationId(): string {
    return `op_${randomUUID().replace(/-/g, "")}`;
  }

  /** Stop timers + drop leases (does not release them remotely). */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const held of this.leases.values()) {
      clearInterval(held.renewTimer);
    }
    this.leases.clear();
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Reject any profile id that is not a single, safe path segment before it is
 * ever joined into a filesystem path. Blocks path traversal and absolute-path
 * escapes:
 *   - empty / whitespace-only,
 *   - "." and "..",
 *   - path separators ("/" or "\") and NUL,
 *   - anything outside a conservative allow-list ([A-Za-z0-9._-]).
 * Throws a deterministic {@link SyncErrorCode.InvalidInput} on rejection.
 */
export function assertSafePathSegment(segment: string): void {
  const bad = (why: string): never => {
    throw syncError(SyncErrorCode.InvalidInput, `unsafe profile id: ${why}`, { segment });
  };
  if (typeof segment !== "string" || segment.trim().length === 0) bad("empty");
  if (segment === "." || segment === "..") bad("reserved dot segment");
  if (/[\\/]/.test(segment)) bad("contains a path separator");
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(segment)) bad("contains a NUL byte");
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) bad("contains disallowed characters");
  if (segment.length > 255) bad("too long");
}

/**
 * Coerce a correlation identifier into the adapter's tag allow-list
 * ([A-Za-z0-9._-], 1..200 chars). Any disallowed character is replaced with
 * `_`; an empty result falls back to "unknown". This mirrors the adapter's
 * `validateTags` contract so a snapshot never fails on an odd id, while still
 * guaranteeing no control chars / secrets can ride along on argv.
 */
export function sanitizeTagValue(value: string): string {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * Robustly extract a snapshot id from Kopia's `snapshot create --json` output.
 * Kopia has emitted different shapes across versions; probe common fields and
 * fall back to a scan for an id-like value.
 */
export function extractSnapshotId(json: unknown): string | null {
  if (json == null) return null;
  const candidates = Array.isArray(json) ? json : [json];
  for (const entry of candidates) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    // Common: { id: "..." } or { rootEntry: { obj: "..." } } or { manifestId }
    if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
    if (typeof obj.snapshotID === "string" && obj.snapshotID.length > 0) return obj.snapshotID;
    if (typeof obj.manifestId === "string" && obj.manifestId.length > 0) return obj.manifestId;
    const root = obj.rootEntry as Record<string, unknown> | undefined;
    if (root && typeof root.obj === "string" && root.obj.length > 0) return root.obj;
    if (typeof obj.rootID === "string" && obj.rootID.length > 0) return obj.rootID;
  }
  return null;
}

function manifestProxyToConfig(proxy: unknown): Profile["proxy"] {
  if (typeof proxy !== "object" || proxy === null) return undefined;
  const p = proxy as Record<string, unknown>;
  if (typeof p.host !== "string" || typeof p.port !== "number") return undefined;
  const type = p.type === "socks5" ? "socks5" : "http";
  // Credentials are intentionally absent from a manifest — the user re-enters.
  return { type, host: p.host, port: p.port };
}

function normalizeError(err: unknown): SyncError {
  if (isSyncError(err)) return err;
  return syncError(SyncErrorCode.Internal, err instanceof Error ? err.message : String(err));
}
