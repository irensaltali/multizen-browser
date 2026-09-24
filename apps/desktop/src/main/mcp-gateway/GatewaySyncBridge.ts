/**
 * S3 project-config sync composition for the desktop gateway.
 *
 * When Cloud Sync becomes ready, this bridge is constructed with the SAME
 * object store + control prefix Cloud Sync uses, plus the operator encryption
 * password and the device signing key. It composes the core
 * {@link ProjectSyncCoordinator} and {@link TrustRegistrySync} — both scoped to
 * the reserved `<controlPrefix>/mcp/…` namespace, entirely separate from the
 * browser-profile keys — and runs a single-flight sync:
 *
 *   local load → remote restore/quarantine/conflicts → persist accepted →
 *   verify → hand the accepted set back for runtime reconcile.
 *
 * The gateway works fully offline: when this bridge is absent (Cloud Sync not
 * configured), the service uses local config only. Local edits are published as
 * signed envelopes with expected revisions; a lost CAS becomes a durable local
 * conflict copy (keep-both), never last-write-wins. No browser-profile deletion
 * is ever coupled to config sync.
 *
 * SECURITY: the encryption password lives only in this main-process object and
 * is passed only into the coordinator's in-memory sealing; it is never logged,
 * serialized, or exposed across IPC.
 */

import {
  ProjectSyncCoordinator,
  TrustRegistrySync,
  type AppliedProject,
  type ConflictOutcome,
  type ProjectConfig,
  type PublishResult,
  type QuarantinedProject,
  type SigningKey,
  type SyncObjectStore,
  type TrustRegistry,
} from "@multizen/mcp-gateway";

export interface GatewaySyncBridgeConfig {
  readonly store: SyncObjectStore;
  readonly controlPrefix: string;
  /** Operator encryption password (in-memory only; never leaves this object). */
  readonly password: string;
  /** Per-repository config-sync salt (hex, not secret). */
  readonly saltHex: string;
  /** This device's signing key (private material stays in the vault). */
  readonly signingKey: SigningKey;
}

/** Result of one whole-library config-sync pass. */
export interface GatewaySyncResult {
  /** Verified, ready-to-apply projects (enabled AND disabled). */
  readonly applied: readonly AppliedProject[];
  /** Rejected/quarantined records — never auto-started. */
  readonly quarantined: readonly QuarantinedProject[];
  /** Number of remote head keys scanned. */
  readonly scanned: number;
  /** The self-verified trust registry used for this pass. */
  readonly registry: TrustRegistry;
}

export class GatewaySyncBridge {
  private readonly coordinator: ProjectSyncCoordinator;
  private readonly trust: TrustRegistrySync;

  constructor(private readonly config: GatewaySyncBridgeConfig) {
    this.coordinator = new ProjectSyncCoordinator({
      store: config.store,
      controlPrefix: config.controlPrefix,
      password: config.password,
      saltHex: config.saltHex,
      signingKey: config.signingKey,
    });
    this.trust = new TrustRegistrySync(config.store, config.controlPrefix);
  }

  /**
   * Fetch the current trust registry, bootstrapping this device as the sole
   * trust root on a fresh bucket. Self-verified before return.
   */
  async ensureTrustRegistry(): Promise<TrustRegistry> {
    return this.trust.fetchOrBootstrap(this.config.signingKey);
  }

  /** Fetch the current trust registry (null when none exists yet). */
  async fetchTrustRegistry(): Promise<TrustRegistry | null> {
    const res = await this.trust.fetch();
    return res?.registry ?? null;
  }

  /** Approve (trust) a device by publishing a signed registry update. */
  async approveDevice(
    entries: Parameters<TrustRegistrySync["update"]>[1],
  ): Promise<TrustRegistry> {
    return this.trust.update(this.config.signingKey, entries);
  }

  /**
   * Whole-library restore: discover + verify every remote project head against
   * the (bootstrapped) trust registry. `knownRevisions` provides rollback
   * protection using the last-applied revision per project.
   */
  async restoreAll(
    knownRevisions?: ReadonlyMap<string, number>,
  ): Promise<GatewaySyncResult> {
    const registry = await this.ensureTrustRegistry();
    const result = await this.coordinator.restoreAll(registry, knownRevisions);
    return { ...result, registry };
  }

  /**
   * Publish a local config edit at `revision` (strictly monotonic). A lost CAS
   * returns a {@link ConflictOutcome} carrying the losing signed config for a
   * durable keep-both local copy. Never overwrites a newer remote.
   */
  async publish(config: ProjectConfig, revision: number): Promise<PublishResult> {
    return this.coordinator.publish(config, revision);
  }

  /** Narrow type guard for a conflict publish outcome. */
  static isConflict(result: PublishResult): result is ConflictOutcome {
    return result.kind === "conflict";
  }
}
