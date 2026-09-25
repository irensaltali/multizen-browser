/**
 * GatewayService — the cohesive main-process MCP gateway.
 *
 * Owns and wires together:
 *   - the atomic {@link ProjectConfigStore} (one file per project under
 *     `<userData>/mcp-gateway/projects/`);
 *   - the {@link GatewayVault} device signing key + per-project local-auth
 *     tokens + sync salt (behind the OS-secure {@link CredentialVault});
 *   - the {@link GatewayRuntime} desired-state reconciliation of stdio/http
 *     upstreams and relay sessions;
 *   - the {@link GatewayHttpRouter} same-port route dispatch, exposed as the
 *     app's single HttpTransport `gatewayHandler`;
 *   - profile-bound browser servers (one cached per bound project);
 *   - optional {@link GatewaySyncBridge} S3 config sync (composed lazily when
 *     Cloud Sync becomes ready) with local-only fallback;
 *   - durable local revision / quarantine / conflict state.
 *
 * Startup: load local configs → (if sync ready) restore/verify remote → persist
 * accepted → reconcile runtime for enabled+trusted+env-resolvable servers.
 * Shutdown: tear down every relay session and upstream (no child/session
 * survives) and close bound servers.
 *
 * NEVER returns expanded env/header/token/private-key material anywhere.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import {
  hashConfig,
  parseProjectConfig,
  ProjectConfigStore,
  projectConfigToJson,
  referencedEnvNames as gatewayReferencedEnvNames,
  SyncedDocumentStore,
  type DocumentPublishResult,
  type DocumentReadResult,
  type DocumentScope,
  type HistoryEntry,
  type JsonValue,
  type ProjectConfig,
  type ProjectAuthPolicy,
  type ServerConfig,
} from "@multizen/mcp-gateway";

import type { CredentialVault } from "../sync/CredentialVault.ts";
import { GatewayVault, managedRefName } from "./GatewayVault.ts";
import { probeReferencedNames, probeServer } from "./ServerProbe.ts";
import { GatewayRuntime, type GatewayRuntimeOptions } from "./GatewayRuntime.ts";
import { GatewayHttpRouter } from "./GatewayHttpRouter.ts";
import { WorkspaceBindingStore } from "./WorkspaceBindingStore.ts";
import { AgentConfigManager, type InstallFailure } from "./AgentConfigManager.ts";
import { ConfigFileTransactor } from "./ConfigFileTransactor.ts";
import {
  browserEntryKey,
  projectTokenEnvName,
  proxyEntryKey,
  type DesiredEndpoint,
} from "./agentAdapters.ts";
import {
  createProfileBoundServer,
  type ProfileBoundServer,
  type ProfileBoundServerOptions,
} from "./ProfileBoundServer.ts";
import { GatewaySyncBridge } from "./GatewaySyncBridge.ts";
import type {
  BindableProfileView,
  ConflictView,
  GatewaySyncStatusView,
  ProbeResultView,
  QuarantineView,
  ReconcileResultView,
  SecretRefStatusView,
  WorkspaceBindingView,
} from "./types.ts";

/** Durable per-project sync/verification state (never carries secrets). */
interface GatewayState {
  /** projectId -> last applied config revision (rollback protection). */
  revisions: Record<string, number>;
  /** projectId -> quarantine record. */
  quarantine: Record<string, QuarantineView>;
  /** projectId -> conflict copies (keep-both). */
  conflicts: Record<string, ConflictRecord[]>;
  /** Synced-document slot -> last applied revision (rollback protection). */
  documentRevisions: Record<string, number>;
}

/**
 * A conflict copy as PERSISTED, which keeps the losing local config itself.
 *
 * The IPC view ({@link ConflictView}) deliberately omits it: the renderer only
 * needs a summary and a choice, and shipping whole configs to it would widen the
 * surface for no benefit. Storing it here is what makes "keep-both" true —
 * previously only metadata was recorded, so the losing local edit was
 * unrecoverable and the next sync pass silently overwrote it with the remote.
 */
interface ConflictRecord extends ConflictView {
  /** Canonical JSON of the local config that lost the race. */
  readonly losingConfigJson: unknown;
}

const EMPTY_STATE: GatewayState = {
  revisions: {},
  quarantine: {},
  conflicts: {},
  documentRevisions: {},
};

/** Background re-sync cadence, and the floor between opportunistic passes. */
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_AUTO_SYNC_MIN_INTERVAL_MS = 30_000;

export interface GatewayServiceDeps {
  /** Root data directory (typically app.getPath("userData")). */
  readonly dataDir: string;
  /** OS-secure credential vault (shared with Cloud Sync). */
  readonly vault: CredentialVault;
  /** Loopback host authorities the HTTP router accepts (e.g. "127.0.0.1:7777"). */
  readonly allowedHosts: readonly string[];
  /**
   * Base URL of the gateway's endpoints, e.g. "http://127.0.0.1:7777". Used both
   * for the copyable endpoint views and for the URLs written into agent files.
   */
  readonly baseUrl: string;
  /** Build a profile-bound browser server for a project (browserDriver etc.). */
  readonly makeBoundServer: (
    projectId: string,
    boundProfileId: string,
  ) => Omit<ProfileBoundServerOptions, "boundProfileId">;
  /**
   * Resolve browser-profile display names for the binding selector. Optional so
   * tests can omit it; the gateway never mutates profiles through this.
   */
  readonly listProfiles?: () => ReadonlyArray<{ id: string; name: string }>;
  /** Optional runtime options (env allowlist, injected factories for tests). */
  readonly runtimeOptions?: GatewayRuntimeOptions;
  /**
   * Source of host environment values for approved references. Defaults to
   * `process.env`; injectable so tests need not mutate the real environment.
   */
  readonly envSource?: Readonly<Record<string, string | undefined>>;
  /** App version, reported to an upstream during a connection test. */
  readonly appVersion?: string;
  /**
   * Automatic re-sync cadence. Project sync previously ran only at startup, so a
   * change made on another device never appeared without restarting the app, and
   * configuring Cloud Sync after launch left the channel composed-as-off.
   *
   * `intervalMs` is the background pass cadence (0 disables the timer);
   * `minIntervalMs` is the floor between opportunistic passes (window focus), so
   * refocusing the app repeatedly cannot hammer the bucket. An explicit Retry
   * always bypasses the floor.
   */
  readonly autoSync?: {
    readonly intervalMs?: number;
    readonly minIntervalMs?: number;
  };
  /** Clock, injectable so the rate limiter is testable without sleeping. */
  readonly now?: () => number;
  /**
   * Operator-facing name for THIS device, used in its trust announcement so the
   * approval prompt on another machine is recognisable rather than a bare id.
   */
  readonly deviceName?: string;
  /**
   * Called after anything that changes this device's folder/agent bindings or its
   * environment approvals, so the per-device backup can be refreshed.
   *
   * A callback rather than a direct dependency because the backup is built ON TOP
   * of this service (it reads through `publishDocument`), so wiring it inward
   * would be circular. Implementations must not throw.
   */
  readonly onBindingsChanged?: () => void;
  /**
   * Called after anything that changes a credential the opt-in bundle may carry,
   * so the backup can be refreshed. `purgeProjects` names projects whose secrets
   * should be dropped from the backup outright — the one case the merge cannot
   * infer, because a deleted project stops being "held here" at the same moment
   * its secrets should disappear.
   *
   * A callback for the same reason as {@link onBindingsChanged}: the backup is
   * built on top of this service. Implementations must not throw.
   */
  readonly onSecretsChanged?: (change?: { purgeProjects?: readonly string[] }) => void;
  /**
   * Provide S3 sync materials when Cloud Sync is ready, else null. Called at
   * startup and on explicit re-sync. The password never leaves the returned
   * object's use inside {@link GatewaySyncBridge}.
   */
  readonly syncMaterials?: () => Promise<{
    store: import("@multizen/mcp-gateway").SyncObjectStore;
    controlPrefix: string;
    password: string;
    deviceId: string;
  } | null>;
}

export class GatewayService {
  private readonly store: ProjectConfigStore;
  private readonly vault: GatewayVault;
  readonly runtime: GatewayRuntime;
  readonly httpRouter: GatewayHttpRouter;
  /** Device-local directory associations + agent install bookkeeping. */
  readonly workspaces: WorkspaceBindingStore;
  /** Installs this device's projects into their directories' agent configs. */
  readonly agentConfigs: AgentConfigManager;
  private readonly stateFile: string;
  private readonly envSource: Readonly<Record<string, string | undefined>>;
  private state: GatewayState = { ...EMPTY_STATE };
  /** Latest verified/desired config per project id. */
  private readonly configs = new Map<string, ProjectConfig>();
  /** Cached profile-bound servers keyed by projectId. */
  private readonly boundServers = new Map<string, ProfileBoundServer>();
  private sync: GatewaySyncBridge | null = null;
  private documents: SyncedDocumentStore | null = null;
  private syncStatus: GatewaySyncStatusView = {
    ready: false,
    lastSyncAt: null,
    lastError: null,
    applied: 0,
    quarantined: 0,
    conflicts: 0,
    running: false,
  };
  private syncInFlight: Promise<void> | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lastAutoSyncAt = 0;

  constructor(private readonly deps: GatewayServiceDeps) {
    const root = path.join(deps.dataDir, "mcp-gateway");
    this.store = new ProjectConfigStore(path.join(root, "projects"));
    this.stateFile = path.join(root, "state.json");
    this.workspaces = new WorkspaceBindingStore(path.join(root, "workspaces.json"));
    this.vault = new GatewayVault(deps.vault);
    this.envSource = deps.envSource ?? process.env;
    this.runtime = new GatewayRuntime({
      ...deps.runtimeOptions,
      // Prefer a MultiZen-managed vault value; otherwise read an APPROVED host
      // environment variable. Values exist only for the duration of a launch.
      secretResolver: {
        resolve: async (projectId, names) => {
          const out: Record<string, string> = {};
          for (const name of names) {
            const managed = await this.vault.getManagedSecret(projectId, name).catch(() => null);
            if (managed !== null) {
              out[name] = managed;
              continue;
            }
            if (!this.workspaces.isEnvApproved(name)) continue;
            const v = this.envSource[name];
            if (v !== undefined) out[name] = v;
          }
          return out;
        },
      },
    });
    this.httpRouter = new GatewayHttpRouter({
      runtime: this.runtime,
      allowedHosts: deps.allowedHosts,
      authPolicyFor: (projectId) => this.authPolicyFor(projectId),
      projectEnabled: (projectId) => {
        const c = this.configs.get(projectId);
        return c !== undefined && c.enabled && !this.quarantineSuppresses(projectId);
      },
      boundServerFor: (projectId) => this.boundServerFor(projectId),
    });
    this.agentConfigs = new AgentConfigManager({
      workspaces: this.workspaces,
      transactor: new ConfigFileTransactor({
        // Backups live under userData, never inside a user's project directory.
        backupDir: path.join(root, "agent-config-backups"),
      }),
      desiredFor: (projectId) => this.desiredEndpointsFor(projectId),
    });
  }

  /** Base URL of the gateway's endpoints. */
  get baseUrl(): string {
    return this.deps.baseUrl;
  }

  /**
   * The endpoints a project should currently expose: one per ENABLED upstream
   * server plus the browser route when a profile is bound. A disabled or
   * quarantined project yields none, which uninstalls it from every agent file.
   */
  desiredEndpointsFor(projectId: string): DesiredEndpoint[] {
    const config = this.configs.get(projectId);
    if (!config || !config.enabled || this.quarantineSuppresses(projectId)) return [];
    const base = this.deps.baseUrl.replace(/\/$/, "");
    // When the project requires a bearer token, agent files reference the
    // token's environment variable NAME — never the token itself.
    const authEnvName = config.localAuth.enabled
      ? projectTokenEnvName(projectId)
      : undefined;
    const out: DesiredEndpoint[] = [];
    for (const server of config.servers) {
      if (server.disabled) continue;
      out.push({
        key: proxyEntryKey(projectId, server.id),
        url: `${base}/mcp/proxies/${projectId}/${server.id}`,
        ...(authEnvName !== undefined ? { authEnvName } : {}),
      });
    }
    if (config.browserProfileId !== undefined) {
      out.push({
        key: browserEntryKey(projectId),
        url: `${base}/mcp/projects/${projectId}/browser`,
        ...(authEnvName !== undefined ? { authEnvName } : {}),
      });
    }
    return out;
  }

  /** The HttpTransport `gatewayHandler` binding. */
  get gatewayHandler(): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean> {
    return (req, res) => this.httpRouter.handle(req, res);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the gateway: init store, load local configs, compose sync if ready,
   * restore/verify remote, persist accepted, then reconcile the runtime.
   */
  async start(): Promise<void> {
    await this.store.init();
    await this.workspaces.load();
    await this.loadState();
    await this.loadLocalConfigs();
    // Compose S3 sync if Cloud Sync is ready; local-only otherwise.
    await this.composeSyncIfReady();
    await this.syncNow().catch(() => {});
    await this.reconcile();
    this.startAutoSync();
  }

  /** Shut down: tear down router sessions, runtime upstreams, bound servers. */
  async shutdown(): Promise<void> {
    // Stop the scheduler first so a tick cannot start a pass mid-teardown.
    this.stopAutoSync();
    await this.httpRouter.shutdown().catch(() => {});
    await this.runtime.shutdown().catch(() => {});
    for (const bound of this.boundServers.values()) {
      await bound.close().catch(() => {});
    }
    this.boundServers.clear();
  }

  // ── automatic re-sync ───────────────────────────────────────────────────

  /**
   * Start the background pass timer. Idempotent, and a no-op when the cadence is
   * zero. The handle is unref'd so it never holds the process open.
   */
  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  startAutoSync(): void {
    const intervalMs = this.deps.autoSync?.intervalMs ?? DEFAULT_AUTO_SYNC_INTERVAL_MS;
    if (intervalMs <= 0 || this.autoSyncTimer !== null) return;
    const timer = setInterval(() => {
      void this.maybeSync("timer");
    }, intervalMs);
    timer.unref?.();
    this.autoSyncTimer = timer;
  }

  /** Stop the background pass timer. Idempotent. */
  stopAutoSync(): void {
    if (this.autoSyncTimer === null) return;
    clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
  }

  /**
   * True while the background pass timer is armed. Exposed so shutdown can be
   * asserted deterministically — waiting to observe that no further pass happens
   * is unreliable, because a single pass includes scrypt derivation and can
   * outlast any reasonable test window.
   */
  get autoSyncActive(): boolean {
    return this.autoSyncTimer !== null;
  }

  /**
   * Opportunistic sync, used by the timer and by window focus.
   *
   * Two jobs beyond running a pass. First, it re-attempts composition when the
   * bridge is absent, so Cloud Sync configured after launch starts working on its
   * own rather than only via an explicit Retry. Second, it enforces a minimum gap
   * between passes so refocusing the window repeatedly cannot hammer the bucket.
   *
   * Returns true when a pass actually ran. Concurrent callers collapse onto the
   * existing in-flight pass via {@link syncNow}.
   */
  async maybeSync(reason: "timer" | "focus"): Promise<boolean> {
    if (this.sync === null) {
      // Cheap when still unconfigured: syncMaterials returns null and we stop.
      const composed = await this.composeSyncIfReady().catch(() => false);
      if (!composed) return false;
    }
    const now = this.clock();
    const floor = this.deps.autoSync?.minIntervalMs ?? DEFAULT_AUTO_SYNC_MIN_INTERVAL_MS;
    if (reason === "focus" && now - this.lastAutoSyncAt < floor) return false;
    this.lastAutoSyncAt = now;
    await this.syncNow();
    return true;
  }

  /**
   * Publish a synced document, tracking its revision so callers do not have to.
   *
   * Returns null when Cloud Sync is not composed — publishing is best-effort by
   * design, since every document also has an authoritative local copy. A lost
   * compare-and-swap is returned as a conflict rather than resolved here: the
   * document's owner decides, because only it knows whether two versions merge.
   */
  async publishDocument(
    scope: DocumentScope,
    name: string,
    value: JsonValue,
  ): Promise<DocumentPublishResult | null> {
    const docs = this.documents;
    if (!docs) return null;
    const slot = this.documentSlot(scope, name);
    const next = (this.state.documentRevisions[slot] ?? 0) + 1;
    const result = await docs.publish(scope, name, value, next);
    if (result.kind === "published") {
      this.state.documentRevisions[slot] = result.revision;
      await this.saveState();
    } else {
      // Adopt the remote revision so the next attempt is contiguous instead of
      // retrying the same losing number forever.
      this.state.documentRevisions[slot] = result.remoteRevision;
      await this.saveState();
    }
    return result;
  }

  /**
   * Read a synced document. Returns null when Cloud Sync is not composed.
   *
   * `expectFresh` applies rollback protection using the last revision this device
   * applied; pass false during an explicit restore, where re-applying the current
   * revision onto a blank device is exactly what is wanted.
   */
  async readDocument<T>(
    scope: DocumentScope,
    name: string,
    options: { deviceId?: string; expectFresh?: boolean } = {},
  ): Promise<DocumentReadResult<T> | null> {
    const docs = this.documents;
    if (!docs || !this.sync) return null;
    const registry = await this.sync.fetchTrustRegistry();
    if (!registry) return null;
    const slot = this.documentSlot(scope, name, options.deviceId);
    const last =
      options.expectFresh === false ? 0 : (this.state.documentRevisions[slot] ?? 0);
    const result = await docs.read<T>(scope, name, registry, {
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      lastAppliedRevision: last,
    });
    if (result.kind === "loaded") {
      this.state.documentRevisions[slot] = result.document.revision;
      await this.saveState();
    }
    return result;
  }

  /** Stable local key for a document's revision counter. */
  private documentSlot(scope: DocumentScope, name: string, deviceId?: string): string {
    if (scope === "shared") return `shared:${name}`;
    return `device:${deviceId ?? this.documents?.selfDeviceId ?? "self"}:${name}`;
  }

  /** The document store, or null when Cloud Sync is not composed. */
  get documentStore(): SyncedDocumentStore | null {
    return this.documents;
  }

  /**
   * Every folder binding on this device as (project, directory, agent kinds).
   *
   * Deliberately NOT `WorkspaceBindingView`: install status, hashes and owned
   * entry keys describe files on disk, and the disk is the authority for those.
   * A backup carries only the operator's intent — which folders, which agents.
   */
  allBindingIntents(): Array<{
    projectId: string;
    directory: string;
    agents: import("./types.ts").AgentKind[];
  }> {
    return this.workspaces.listAll().map((b) => ({
      projectId: b.projectId,
      directory: b.directory,
      agents: b.agents.map((a) => a.agent),
    }));
  }

  /** Environment variable names approved for expansion on this device. */
  approvedEnvNames(): string[] {
    return this.workspaces.approvedEnv();
  }

  // ── configuration history ───────────────────────────────────────────────

  /**
   * A project's revision timeline. Empty when Cloud Sync is not composed: history
   * is a property of the bucket, so a device-only project genuinely has none.
   */
  async projectHistory(projectId: string): Promise<HistoryEntry[]> {
    if (!this.sync) return [];
    return this.sync.history(projectId);
  }

  /**
   * Roll a project back to an archived revision by PUBLISHING that content as the
   * newest revision.
   *
   * Deliberately not a rewrite of history: republishing forward means other
   * devices see an ordinary edit and accept it, whereas resetting the head to an
   * older number would look like exactly the rollback attack their replay
   * protection exists to refuse. The old revision also stays in the archive, so
   * undoing the undo is possible.
   */
  async restoreProjectRevision(
    projectId: string,
    revision: number,
  ): Promise<{ restored: true; revision: number } | { restored: false; reason: string }> {
    if (!this.sync) {
      return { restored: false, reason: "not-syncing" };
    }
    const archived = await this.sync.readRevision(projectId, revision);
    if (archived === null) return { restored: false, reason: "absent" };
    const current = this.configs.get(projectId);
    if (current !== undefined && hashConfig(current) === hashConfig(archived.config)) {
      return { restored: false, reason: "unchanged" };
    }
    // Goes through the normal save path, so it is persisted locally, published at
    // head+1, and reconciled into the runtime exactly like any other edit.
    await this.saveConfig(archived.config);
    return { restored: true, revision: this.lastRevision(projectId) };
  }

  /**
   * True when a quarantine record should stop this project running locally.
   *
   * A record with `localRetained` means only the REMOTE copy was refused: this
   * device holds its own config and keeps serving it, so the project is not
   * suppressed. Anything else — including a legacy record written before this
   * field existed — suppresses, which is the safe direction.
   */
  private quarantineSuppresses(projectId: string): boolean {
    const q = this.state.quarantine[projectId];
    return q !== undefined && q.localRetained !== true;
  }

  private async loadLocalConfigs(): Promise<void> {
    const { projects } = await this.store.loadAll();
    this.configs.clear();
    for (const { config } of projects) {
      if (this.quarantineSuppresses(config.id)) continue;
      this.configs.set(config.id, config);
    }
  }

  /** Reconcile the runtime against the current non-quarantined enabled configs. */
  async reconcile(): Promise<void> {
    const desired = [...this.configs.values()].filter((c) => !this.quarantineSuppresses(c.id));
    await this.runtime.reconcile(desired);
  }

  // ── S3 config sync ──────────────────────────────────────────────────────

  /** Compose the S3 sync bridge if Cloud Sync materials are available. */
  async composeSyncIfReady(): Promise<boolean> {
    if (!this.deps.syncMaterials) {
      this.sync = null;
      this.documents = null;
      this.syncStatus = { ...this.syncStatus, ready: false };
      return false;
    }
    const mats = await this.deps.syncMaterials().catch(() => null);
    if (!mats) {
      this.sync = null;
      this.documents = null;
      this.syncStatus = { ...this.syncStatus, ready: false };
      return false;
    }
    const signingKey = await this.vault.getOrCreateSigningKey();
    const saltHex = await this.vault.getOrCreateSaltHex();
    this.sync = new GatewaySyncBridge({
      store: mats.store,
      controlPrefix: mats.controlPrefix,
      password: mats.password,
      saltHex,
      signingKey,
    });
    // The document store shares the same bucket, password, salt and signing key
    // as project sync, so settings/bindings/credentials inherit every guarantee
    // the project channel already has instead of re-deriving them.
    this.documents = new SyncedDocumentStore({
      store: mats.store,
      controlPrefix: mats.controlPrefix,
      password: mats.password,
      saltHex,
      signingKey,
    });
    this.syncStatus = { ...this.syncStatus, ready: true };
    // If this device is not an entry in the registry it cannot publish anything,
    // and an admin on another device has no way to discover it. Announce so the
    // approval UI has something to act on. Best-effort: failing to announce must
    // never stop the gateway working locally.
    await this.announceSelfIfUntrusted().catch(() => undefined);
    return true;
  }

  /**
   * Publish this device's self-announcement unless it is already a registry
   * entry (trusted or revoked — a revoked device must not be able to re-list
   * itself as merely "pending" and invite a careless re-approval).
   */
  private async announceSelfIfUntrusted(): Promise<void> {
    if (!this.sync) return;
    const registry = await this.sync.fetchTrustRegistry();
    const selfId = this.sync.selfDeviceId;
    if (registry?.entries.some((e) => e.deviceId === selfId) === true) return;
    await this.sync.announceSelf(this.deps.deviceName ?? "This device");
  }

  /**
   * Single-flight whole-library config sync: restore/verify remote, persist
   * accepted (respecting rollback), record quarantine, then reconcile runtime.
   * A no-op (local-only) when no sync bridge is composed.
   */
  async syncNow(): Promise<void> {
    if (!this.sync) return;
    if (this.syncInFlight) return this.syncInFlight;
    const run = this.doSync().finally(() => {
      this.syncInFlight = null;
    });
    this.syncInFlight = run;
    return run;
  }

  private async doSync(): Promise<void> {
    if (!this.sync) return;
    this.syncStatus = { ...this.syncStatus, running: true };
    try {
      const known = new Map(Object.entries(this.state.revisions));
      const result = await this.sync.restoreAll(known);
      // Persist accepted configs locally (never overwriting a newer local
      // revision) and update the runtime desired set.
      for (const applied of result.applied) {
        const prior = this.state.revisions[applied.projectId] ?? 0;
        if (applied.revision < prior) continue; // rollback guard
        await this.store.save(applied.config);
        this.configs.set(applied.projectId, applied.config);
        this.state.revisions[applied.projectId] = applied.revision;
        delete this.state.quarantine[applied.projectId];
      }
      // Deletions made on another device. Local cleanup runs BEFORE the project
      // is forgotten, so agent config files never keep entries for a project that
      // no longer exists; a cleanup failure is reported and retried rather than
      // orphaning them.
      for (const d of result.deleted) {
        const prior = this.state.revisions[d.projectId] ?? 0;
        if (d.revision <= prior) continue; // already processed
        const failures = await this.agentConfigs
          .uninstallProject(d.projectId)
          .catch((err: unknown) => [
            { directory: "", agent: "cursor" as const, message: (err as Error).message },
          ]);
        if (failures.length > 0) {
          this.state.quarantine[d.projectId] = {
            projectId: d.projectId,
            reason: `deleted on ${d.signer} but this device could not clean up: ${failures
              .map((f) => `${f.agent} in ${f.directory}: ${f.message}`)
              .join("; ")}`,
            code: "cleanup-failed",
            detectedAt: new Date().toISOString(),
            localRetained: true,
          };
          continue;
        }
        await this.agentConfigs.forgetProject(d.projectId);
        await this.removeConfig(d.projectId, d.revision);
      }

      for (const q of result.quarantined) {
        // Refusing a remote record must NOT destroy local state. If this device
        // already holds the project — because it authored it and is waiting for
        // approval, or because it applied a good revision earlier — the local
        // copy stays authoritative here and keeps serving. Otherwise there is
        // nothing to retain and the project stays inert.
        //
        // Deleting on refusal would hand a denial of service to anyone who can
        // write the bucket: publishing a garbage head under a project id would
        // take that project down on every device.
        const localRetained = this.configs.has(q.projectId);
        this.state.quarantine[q.projectId] = {
          projectId: q.projectId,
          reason: q.reason,
          code: q.code,
          detectedAt: new Date().toISOString(),
          localRetained,
        };
        if (!localRetained) this.configs.delete(q.projectId);
      }
      await this.saveState();
      await this.reconcile();
      this.syncStatus = {
        ready: true,
        lastSyncAt: Date.now(),
        lastError: null,
        applied: result.applied.length,
        quarantined: result.quarantined.length,
        conflicts: this.totalConflicts(),
        running: false,
      };
    } catch (err) {
      this.syncStatus = {
        ...this.syncStatus,
        running: false,
        lastError: (err as Error).message.slice(0, 200),
      };
    }
  }

  /** Publish a local config edit as the next signed revision (if sync ready). */
  private async publishIfSyncing(config: ProjectConfig): Promise<void> {
    if (!this.sync) return;
    const next = (this.state.revisions[config.id] ?? 0) + 1;
    const result = await this.sync.publish(config, next).catch(() => null);
    if (!result) return;
    if (GatewaySyncBridge.isConflict(result)) {
      const list = this.state.conflicts[config.id] ?? [];
      list.push({
        projectId: config.id,
        attemptedRevision: result.attemptedRevision,
        remoteRevision: result.remoteRevision,
        localSigner: result.metadata.localSigner,
        remoteSigner: result.metadata.remoteSigner,
        detectedAt: result.metadata.detectedAt,
        reason: result.metadata.reason,
        // Keep the actual losing config, not just a note that it lost.
        losingConfigJson: projectConfigToJson(result.losingConfig),
      });
      this.state.conflicts[config.id] = list;
      await this.saveState();
      return;
    }
    this.state.revisions[config.id] = result.revision;
    await this.saveState();
  }

  /**
   * Stable comparable shape for one server. Field order is normalised so a
   * cosmetic key reordering never reads as a change.
   */
  private static serverComparable(s: ProjectConfig["servers"][number]): unknown {
    return s.transport === "stdio"
      ? {
          transport: s.transport,
          id: s.id,
          label: s.label ?? null,
          disabled: s.disabled,
          command: s.command,
          args: [...s.args],
          env: Object.fromEntries(Object.entries(s.env).sort()),
          cwd: s.cwd ?? null,
        }
      : {
          transport: s.transport,
          id: s.id,
          label: s.label ?? null,
          disabled: s.disabled,
          url: s.url,
          headers: Object.fromEntries(Object.entries(s.headers).sort()),
        };
  }

  private totalConflicts(): number {
    return Object.values(this.state.conflicts).reduce((n, c) => n + c.length, 0);
  }

  // ── auth policy ────────────────────────────────────────────────────────

  /**
   * Resolve a project's inbound auth policy for the router. Default OFF. When a
   * project enables localAuth we read its device-local token from the vault for
   * the constant-time compare done inside the core Router; the token value is
   * used only there and never returned.
   */
  private async authPolicyFor(projectId: string): Promise<ProjectAuthPolicy | undefined> {
    const config = this.configs.get(projectId);
    if (!config || !config.localAuth.enabled) return { authRequired: false };
    const token = await this.vault.getProjectToken(projectId);
    if (!token) {
      // Auth enabled but no token stored — fail closed (require, but no valid
      // token exists so every request is rejected).
      return { authRequired: true };
    }
    return { authRequired: true, expectedToken: token };
  }

  // ── profile-bound browser servers ───────────────────────────────────────

  private async boundServerFor(projectId: string): Promise<ProfileBoundServer | null> {
    const config = this.configs.get(projectId);
    if (!config || !config.browserProfileId) return null;
    const cached = this.boundServers.get(projectId);
    if (cached && cached.boundProfileId === config.browserProfileId) return cached;
    if (cached) await cached.close().catch(() => {});
    const opts = this.deps.makeBoundServer(projectId, config.browserProfileId);
    const bound = await createProfileBoundServer({
      ...opts,
      boundProfileId: config.browserProfileId,
    });
    this.boundServers.set(projectId, bound);
    return bound;
  }

  // ── config CRUD (used by the controller) ─────────────────────────────────

  /** Snapshot of a project's verified/desired config, or null. */
  configOf(projectId: string): ProjectConfig | null {
    return this.configs.get(projectId) ?? null;
  }

  /** All non-quarantined configs. */
  allConfigs(): ProjectConfig[] {
    return [...this.configs.values()];
  }

  /** Persist a validated config, update runtime, publish if syncing. */
  async saveConfig(config: ProjectConfig): Promise<void> {
    const validated = parseProjectConfig(projectConfigToJson(config));
    await this.store.save(validated);
    this.configs.set(validated.id, validated);
    delete this.state.quarantine[validated.id];
    await this.saveState();
    // Drop values for references this project no longer has, so removing a
    // server or a header does not leave its secret behind in the keychain.
    await this.pruneManagedSecrets(validated.id).catch(() => undefined);
    await this.reconcile();
    // Any change to a project's servers, enable state, auth, or profile binding
    // changes what its directories should contain. Never throws: per-target
    // failures are recorded for retry.
    await this.agentConfigs.reconcileProject(validated.id).catch(() => undefined);
    await this.publishIfSyncing(validated).catch(() => {});
  }

  // ── local directories + agent configuration ─────────────────────────────

  /** Associate a directory with a project and install the selected agents. */
  async setDirectoryAgents(
    projectId: string,
    directory: string,
    agents: readonly import("./types.ts").AgentKind[],
  ): Promise<void> {
    await this.agentConfigs.setDirectoryAgents(projectId, directory, agents);
    this.deps.onBindingsChanged?.();
  }

  /** Unlink a directory, removing MultiZen's entries from its agent files. */
  async removeDirectory(projectId: string, directory: string): Promise<void> {
    await this.agentConfigs.removeDirectory(projectId, directory);
    this.deps.onBindingsChanged?.();
  }

  /** Re-install a project into every associated directory. */
  async reconcileAgentConfigs(projectId: string): Promise<ReconcileResultView> {
    return this.agentConfigs.reconcileProject(projectId);
  }

  /** Retry one failed directory+agent target. */
  async retryAgentInstall(
    projectId: string,
    directory: string,
    agent: import("./types.ts").AgentKind,
  ): Promise<void> {
    await this.agentConfigs.retry(projectId, directory, agent);
  }

  /** Directory + agent install state for a project. */
  async workspaceBindings(projectId: string): Promise<WorkspaceBindingView[]> {
    return this.agentConfigs.bindings(projectId);
  }

  /**
   * Delete a project safely: MultiZen's entries are removed from every agent
   * file FIRST. If any file cannot be cleaned, the project is KEPT and the
   * failures are returned, so entries are never orphaned in a file belonging to
   * a project that no longer exists. Browser profiles are never touched.
   */
  async deleteProjectSafely(
    projectId: string,
  ): Promise<{ deleted: boolean; failures: InstallFailure[]; syncError?: string }> {
    const failures = await this.agentConfigs.uninstallProject(projectId);
    if (failures.length > 0) return { deleted: false, failures };

    // Announce the deletion BEFORE dropping local state. If the tombstone cannot
    // be published, stop: deleting locally would leave the remote head intact and
    // the very next sync pass would restore the project, which looks to the
    // operator like the delete silently failed to stick.
    let retainRevision: number | undefined;
    if (this.sync) {
      const next = (this.state.revisions[projectId] ?? 0) + 1;
      try {
        await this.sync.publishTombstone(projectId, next);
        retainRevision = next;
      } catch (err) {
        return {
          deleted: false,
          failures: [],
          syncError: `the deletion could not be published: ${(err as Error).message}`,
        };
      }
    }

    await this.agentConfigs.forgetProject(projectId);
    await this.removeConfig(projectId, retainRevision);
    return { deleted: true, failures: [] };
  }

  /**
   * Remove a project's config + local state (never touches browser profiles).
   *
   * `retainRevision` keeps the project's revision counter at the deletion's
   * revision instead of forgetting it. That is what stops a stale remote head
   * from resurrecting the project on the next pass, and stops the tombstone from
   * being reprocessed as a fresh deletion every pass thereafter.
   */
  async removeConfig(projectId: string, retainRevision?: number): Promise<boolean> {
    const existed = await this.store.remove(projectId as never);
    this.configs.delete(projectId);
    if (retainRevision !== undefined) this.state.revisions[projectId] = retainRevision;
    else delete this.state.revisions[projectId];
    delete this.state.quarantine[projectId];
    delete this.state.conflicts[projectId];
    const bound = this.boundServers.get(projectId);
    if (bound) {
      await bound.close().catch(() => {});
      this.boundServers.delete(projectId);
    }
    // Drop this project's device-local secrets and its bearer token. Browser
    // profiles are NEVER touched — a profile outlives the project that bound it.
    await this.vault.deleteAllManagedSecrets(projectId).catch(() => {});
    await this.vault.deleteProjectToken(projectId).catch(() => {});
    await this.saveState();
    await this.reconcile();
    // The project is gone, so its secrets must leave the shared backup too. This
    // is the one removal the backup merge cannot infer: every other path can tell
    // "deleted here" from "never present here" by whether the project is held
    // locally, but a deleted project is absent either way.
    this.deps.onSecretsChanged?.({ purgeProjects: [projectId] });
    return existed;
  }

  /** Invalidate a cached bound server (e.g. after a binding change). */
  async invalidateBoundServer(projectId: string): Promise<void> {
    const bound = this.boundServers.get(projectId);
    if (bound) {
      await bound.close().catch(() => {});
      this.boundServers.delete(projectId);
    }
  }

  // ── local state persistence ───────────────────────────────────────────

  private async loadState(): Promise<void> {
    try {
      const text = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(text) as Partial<GatewayState>;
      this.state = {
        revisions: parsed.revisions ?? {},
        quarantine: parsed.quarantine ?? {},
        conflicts: parsed.conflicts ?? {},
        documentRevisions: parsed.documentRevisions ?? {},
      };
    } catch {
      this.state = { ...EMPTY_STATE, revisions: {}, quarantine: {}, conflicts: {}, documentRevisions: {} };
    }
  }

  private async saveState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const body = JSON.stringify(this.state);
    const tmp = `${this.stateFile}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.stateFile);
  }

  // ── read models for the controller ───────────────────────────────────────

  get vaultAdapter(): GatewayVault {
    return this.vault;
  }

  syncStatusView(): GatewaySyncStatusView {
    return { ...this.syncStatus, conflicts: this.totalConflicts() };
  }

  quarantineList(): QuarantineView[] {
    return Object.values(this.state.quarantine);
  }

  conflictList(): ConflictView[] {
    return Object.values(this.state.conflicts)
      .flat()
      .map(({ losingConfigJson, ...view }) => ({
        ...view,
        // Summarised against what is authoritative NOW, because that is the
        // comparison the operator is actually making: "what changes if I keep
        // mine instead of what the other device published?"
        differences: this.summarizeConflict(view.projectId, losingConfigJson),
      }));
  }

  /**
   * Short, operator-facing list of what the losing local config would change if
   * it were kept. Compared against the currently-applied config.
   */
  private summarizeConflict(projectId: string, losingConfigJson: unknown): string[] {
    const current = this.configs.get(projectId);
    let losing: ProjectConfig;
    try {
      losing = parseProjectConfig(losingConfigJson);
    } catch {
      return ["the stored copy could not be read"];
    }
    if (!current) return ["this project no longer exists on this device"];
    const out: string[] = [];
    if (losing.label !== current.label) out.push("name");
    if (losing.enabled !== current.enabled) {
      out.push(losing.enabled ? "would switch it on" : "would switch it off");
    }
    if (losing.browserProfileId !== current.browserProfileId) out.push("browser profile");
    if (losing.localAuth.enabled !== current.localAuth.enabled) out.push("token requirement");

    const currentServers = new Map(current.servers.map((x) => [x.id, x]));
    const losingServers = new Map(losing.servers.map((x) => [x.id, x]));
    for (const id of losingServers.keys()) {
      if (!currentServers.has(id)) out.push(`adds server ${id}`);
    }
    for (const id of currentServers.keys()) {
      if (!losingServers.has(id)) out.push(`removes server ${id}`);
    }
    for (const [id, mine] of losingServers) {
      const theirs = currentServers.get(id);
      if (theirs === undefined) continue;
      if (JSON.stringify(GatewayService.serverComparable(mine)) !== JSON.stringify(GatewayService.serverComparable(theirs))) {
        out.push(`changes server ${id}`);
      }
    }
    return out.length > 0 ? out : ["nothing — the two copies are identical"];
  }

  /**
   * Resolve a project's conflicts by explicit choice.
   *
   * `theirs` accepts what the other device published and discards the local copy
   * — the remote already won the race, so this only clears the records. `mine`
   * re-publishes the stored losing config as the next revision, making the local
   * edit authoritative. Either way nothing is decided implicitly: without this
   * call the records stay, which is the point of keep-both.
   */
  async resolveConflicts(projectId: string, keep: "mine" | "theirs" = "theirs"): Promise<void> {
    const records = this.state.conflicts[projectId] ?? [];
    if (records.length === 0) return;

    if (keep === "mine") {
      // Take the most recent losing copy: it is the latest thing the operator
      // actually asked for on this device.
      const latest = records[records.length - 1]!;
      let config: ProjectConfig;
      try {
        config = parseProjectConfig(latest.losingConfigJson);
      } catch {
        // An unreadable copy cannot be promoted. Leave the records in place
        // rather than silently discarding the operator's edit.
        throw new Error("the stored local copy could not be read");
      }
      // Clear first so the republish (which may itself conflict) records a fresh
      // conflict rather than being mistaken for one of the ones we just resolved.
      delete this.state.conflicts[projectId];
      await this.saveState();
      await this.saveConfig(config);
      return;
    }

    delete this.state.conflicts[projectId];
    await this.saveState();
  }

  /** Release a project from quarantine (re-verify on next sync). */
  async releaseQuarantine(projectId: string): Promise<void> {
    delete this.state.quarantine[projectId];
    await this.saveState();
    await this.loadLocalConfigs();
    await this.reconcile();
  }

  lastRevision(projectId: string): number {
    return this.state.revisions[projectId] ?? 0;
  }

  /** Access to the sync bridge for trust operations (null when local-only). */
  get syncBridge(): GatewaySyncBridge | null {
    return this.sync;
  }

  // ── exclusive browser-profile binding ───────────────────────────────────

  /**
   * Serializes profile-binding changes. Without this, two concurrent binds could
   * both read "profile is free" and both persist, leaving one profile bound to
   * two projects.
   */
  private bindChain: Promise<unknown> = Promise.resolve();

  private serializeBinding<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.bindChain.then(fn, fn);
    this.bindChain = next.catch(() => {});
    return next;
  }

  /** The project currently binding `profileId`, or null when it is free. */
  projectBoundTo(profileId: string): string | null {
    for (const config of this.configs.values()) {
      if (config.browserProfileId === profileId) return config.id;
    }
    return null;
  }

  /**
   * Apply a config mutation that may claim a browser profile, holding the
   * binding lock across the check AND the write so exclusivity cannot be raced.
   *
   * `desiredProfileId`: a string claims that profile, `null` clears a binding,
   * and `undefined` means the mutation does not touch the binding.
   */
  async applyWithBindingGuard(
    projectId: string,
    desiredProfileId: string | null | undefined,
    mutate: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; conflictProjectId: string }> {
    return this.serializeBinding(async () => {
      if (typeof desiredProfileId === "string") {
        const holder = this.projectBoundTo(desiredProfileId);
        if (holder !== null && holder !== projectId) {
          return { ok: false as const, conflictProjectId: holder };
        }
      }
      await mutate();
      return { ok: true as const };
    });
  }

  /**
   * Browser profiles offered in the binding selector. A profile bound to another
   * project is listed but marked unavailable, with the holder named, so the UI
   * can explain WHY it cannot be chosen instead of hiding it.
   */
  bindableProfiles(forProjectId?: string): BindableProfileView[] {
    const profiles = this.deps.listProfiles?.() ?? [];
    return profiles.map((p) => {
      const holder = this.projectBoundTo(p.id);
      return {
        profileId: p.id,
        name: p.name,
        ...(holder !== null ? { boundToProjectId: holder } : {}),
        available: holder === null || holder === forProjectId,
      };
    });
  }

  // ── `${NAME}` reference availability + provisioning ──────────────────────

  /** Every `${NAME}` a project's servers reference, de-duplicated and sorted. */
  referencedEnvNamesOf(projectId: string): string[] {
    const config = this.configs.get(projectId);
    if (!config) return [];
    const refs = new Set<string>();
    const collect = (v: string): void => {
      for (const n of gatewayReferencedEnvNames(v)) refs.add(n);
    };
    for (const s of config.servers) {
      if (s.transport === "stdio") {
        for (const v of Object.values(s.env)) collect(v);
      } else {
        collect(s.url);
        for (const v of Object.values(s.headers)) collect(v);
      }
    }
    return [...refs].sort();
  }

  /**
   * Availability of each reference: NAME, backing source, and presence booleans.
   * NEVER includes a value. A managed value takes precedence over the host
   * environment, matching what the runtime resolver actually does.
   */
  async secretRefStatus(projectId: string): Promise<SecretRefStatusView[]> {
    const names = this.referencedEnvNamesOf(projectId);
    const out: SecretRefStatusView[] = [];
    for (const name of names) {
      const managed = await this.vault.hasManagedSecret(projectId, name).catch(() => false);
      const approved = this.workspaces.isEnvApproved(name);
      const inEnv = this.envSource[name] !== undefined;
      const source: SecretRefStatusView["source"] = managed
        ? "managed"
        : approved && inEnv
          ? "environment"
          : null;
      out.push({
        name,
        source,
        present: managed || (approved && inEnv),
        approved,
        managed,
      });
    }
    return out;
  }

  /** Approve reading one NAME from this device's environment, then reconcile. */
  async approveEnvName(name: string): Promise<void> {
    await this.workspaces.approveEnv(name);
    await this.reconcile();
    this.deps.onBindingsChanged?.();
  }

  /** Revoke an environment approval, then reconcile (may deactivate servers). */
  async revokeEnvName(name: string): Promise<void> {
    await this.workspaces.revokeEnv(name);
    await this.reconcile();
    this.deps.onBindingsChanged?.();
  }

  /** Store a managed value for one reference (write-only), then reconcile. */
  async saveManagedSecret(projectId: string, name: string, value: string): Promise<void> {
    await this.vault.setManagedSecret(projectId, name, value);
    await this.reconcile();
    this.deps.onSecretsChanged?.();
  }

  /** Remove a managed value, then reconcile (may deactivate servers). */
  async deleteManagedSecret(projectId: string, name: string): Promise<void> {
    await this.vault.deleteManagedSecret(projectId, name);
    await this.reconcile();
    this.deps.onSecretsChanged?.();
  }

  /**
   * Mint a fresh bearer token for a project and return it for a one-shot reveal.
   *
   * Lives here rather than being called straight through to the vault so the
   * credential backup learns about the rotation: a token the operator has pasted
   * into an external agent config is exactly the kind of value a restore needs to
   * reproduce, and a backup holding the previous one would be actively misleading.
   */
  async rotateProjectToken(projectId: string): Promise<string> {
    const token = await this.vault.generateProjectToken(projectId);
    this.deps.onSecretsChanged?.();
    return token;
  }

  /**
   * Store raw values typed into a server's env/header fields and return the
   * `${NAME}` references that should take their place.
   *
   * The value goes straight from the argument into OS secure storage under a name
   * derived from (serverId, key); nothing is written to the project config here,
   * and the caller is expected to persist the returned references instead of the
   * values. No reconcile is triggered — the caller's `saveConfig` does one
   * immediately afterwards, and reconciling mid-way would briefly run the server
   * against a config that still lacks the reference.
   *
   * Deliberately NOT exposed on the IPC controller as a general-purpose writer:
   * the only way a value arrives is attached to the server it belongs to.
   */
  async storeInlineSecrets(
    projectId: string,
    serverId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const name = managedRefName(serverId, key);
      await this.vault.setManagedSecret(projectId, name, value);
      refs[key] = `\${${name}}`;
    }
    if (Object.keys(refs).length > 0) this.deps.onSecretsChanged?.();
    return refs;
  }

  /**
   * Delete managed values whose reference no longer appears anywhere in the
   * project's servers.
   *
   * Only touches the managed-secret namespace, so the project's bearer token
   * (stored under a different credential name) is never at risk.
   */
  async pruneManagedSecrets(projectId: string): Promise<void> {
    const referenced = new Set(this.referencedEnvNamesOf(projectId));
    let pruned = false;
    for (const name of await this.vault.managedSecretNames(projectId)) {
      if (!referenced.has(name)) {
        await this.vault.deleteManagedSecret(projectId, name);
        pruned = true;
      }
    }
    if (pruned) this.deps.onSecretsChanged?.();
  }

  /**
   * Run a one-shot connection test against a server definition that may not be
   * saved yet.
   *
   * `overrides` carries values the operator has typed but not stored (NAME ->
   * value), so Test works before Save. Anything not overridden resolves exactly
   * as a launch would: a managed vault value first, then an APPROVED host
   * variable. `projectId` may be null while a project is still being created, in
   * which case only the overrides and approved environment are available.
   *
   * The probe borrows the runtime's own factories and base environment so a pass
   * here means the same thing a real launch would.
   */
  async testServerConnection(
    projectId: string | null,
    server: ServerConfig,
    overrides: Readonly<Record<string, string>> = {},
  ): Promise<ProbeResultView> {
    const resolved: Record<string, string> = {};
    for (const name of probeReferencedNames(server)) {
      const override = overrides[name];
      if (override !== undefined) {
        resolved[name] = override;
        continue;
      }
      if (projectId !== null) {
        const managed = await this.vault.getManagedSecret(projectId, name).catch(() => null);
        if (managed !== null) {
          resolved[name] = managed;
          continue;
        }
      }
      if (!this.workspaces.isEnvApproved(name)) continue;
      const v = this.envSource[name];
      if (v !== undefined) resolved[name] = v;
    }
    const { stdioFactory, httpFactory, baseEnv } = this.runtime.launchPlumbing;
    return probeServer(
      { server, resolved },
      {
        stdioFactory,
        httpFactory,
        baseEnv,
        ...(this.deps.appVersion !== undefined ? { clientVersion: this.deps.appVersion } : {}),
      },
    );
  }
}

export type { GatewayState };
