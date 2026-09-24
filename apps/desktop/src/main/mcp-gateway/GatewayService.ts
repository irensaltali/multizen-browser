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
  parseProjectConfig,
  ProjectConfigStore,
  projectConfigToJson,
  referencedEnvNames as gatewayReferencedEnvNames,
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
  conflicts: Record<string, ConflictView[]>;
}

const EMPTY_STATE: GatewayState = { revisions: {}, quarantine: {}, conflicts: {} };

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
        return c !== undefined && c.enabled && !this.state.quarantine[projectId];
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
    if (!config || !config.enabled || this.state.quarantine[projectId]) return [];
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
  }

  /** Shut down: tear down router sessions, runtime upstreams, bound servers. */
  async shutdown(): Promise<void> {
    await this.httpRouter.shutdown().catch(() => {});
    await this.runtime.shutdown().catch(() => {});
    for (const bound of this.boundServers.values()) {
      await bound.close().catch(() => {});
    }
    this.boundServers.clear();
  }

  private async loadLocalConfigs(): Promise<void> {
    const { projects } = await this.store.loadAll();
    this.configs.clear();
    for (const { config } of projects) {
      if (this.state.quarantine[config.id]) continue;
      this.configs.set(config.id, config);
    }
  }

  /** Reconcile the runtime against the current non-quarantined enabled configs. */
  async reconcile(): Promise<void> {
    const desired = [...this.configs.values()].filter((c) => !this.state.quarantine[c.id]);
    await this.runtime.reconcile(desired);
  }

  // ── S3 config sync ──────────────────────────────────────────────────────

  /** Compose the S3 sync bridge if Cloud Sync materials are available. */
  async composeSyncIfReady(): Promise<boolean> {
    if (!this.deps.syncMaterials) {
      this.sync = null;
      this.syncStatus = { ...this.syncStatus, ready: false };
      return false;
    }
    const mats = await this.deps.syncMaterials().catch(() => null);
    if (!mats) {
      this.sync = null;
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
    this.syncStatus = { ...this.syncStatus, ready: true };
    return true;
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
      for (const q of result.quarantined) {
        this.state.quarantine[q.projectId] = {
          projectId: q.projectId,
          reason: q.reason,
          code: q.code,
          detectedAt: new Date().toISOString(),
        };
        // A quarantined project must never auto-start.
        this.configs.delete(q.projectId);
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
      });
      this.state.conflicts[config.id] = list;
      await this.saveState();
      return;
    }
    this.state.revisions[config.id] = result.revision;
    await this.saveState();
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
  }

  /** Unlink a directory, removing MultiZen's entries from its agent files. */
  async removeDirectory(projectId: string, directory: string): Promise<void> {
    await this.agentConfigs.removeDirectory(projectId, directory);
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
  ): Promise<{ deleted: boolean; failures: InstallFailure[] }> {
    const failures = await this.agentConfigs.uninstallProject(projectId);
    if (failures.length > 0) return { deleted: false, failures };
    await this.agentConfigs.forgetProject(projectId);
    await this.removeConfig(projectId);
    return { deleted: true, failures: [] };
  }

  /** Remove a project's config + local state (never touches browser profiles). */
  async removeConfig(projectId: string): Promise<boolean> {
    const existed = await this.store.remove(projectId as never);
    this.configs.delete(projectId);
    delete this.state.revisions[projectId];
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
      };
    } catch {
      this.state = { revisions: {}, quarantine: {}, conflicts: {} };
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
    return Object.values(this.state.conflicts).flat();
  }

  /** Clear a project's conflicts after explicit resolution. */
  async resolveConflicts(projectId: string): Promise<void> {
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
  }

  /** Revoke an environment approval, then reconcile (may deactivate servers). */
  async revokeEnvName(name: string): Promise<void> {
    await this.workspaces.revokeEnv(name);
    await this.reconcile();
  }

  /** Store a managed value for one reference (write-only), then reconcile. */
  async saveManagedSecret(projectId: string, name: string, value: string): Promise<void> {
    await this.vault.setManagedSecret(projectId, name, value);
    await this.reconcile();
  }

  /** Remove a managed value, then reconcile (may deactivate servers). */
  async deleteManagedSecret(projectId: string, name: string): Promise<void> {
    await this.vault.deleteManagedSecret(projectId, name);
    await this.reconcile();
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
    for (const name of await this.vault.managedSecretNames(projectId)) {
      if (!referenced.has(name)) {
        await this.vault.deleteManagedSecret(projectId, name);
      }
    }
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
