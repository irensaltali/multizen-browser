import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateProfileInput,
  ProfileId,
  ProfileSummary,
  Profile,
  UpdateProfileInput,
  LaunchedProfile,
  FingerprintConfig,
} from "@multizen/types";
import type { ActivityEvent } from "@multizen/mcp-server";
import type { AppSettings } from "@multizen/settings-store";
import type {
  ProfileSyncStatusView,
  SecretKind,
  StorageTestResult,
  SyncConfigView,
  SyncDiagnostics,
  SyncDiagnosticsExport,
  SyncOpResult,
  SyncProgressEvent,
  BootstrapSummary,
  DisableProfileSyncResult,
} from "../main/sync/types.ts";
import type {
  AgentKind,
  BindableProfileView,
  CreateProjectInput,
  GatewayOpResult,
  LocalAuthView,
  ProbeResultView,
  ProjectEndpointsView,
  ProjectRuntimeView,
  ProjectSetupInput,
  ProjectSetupResultView,
  ProjectView,
  ReconcileResultView,
  SecretRefStatusView,
  ServerInput,
  UpdateProjectInput,
  WorkspaceBindingView,
} from "../main/mcp-gateway/types.ts";
import type {
  ChromiumStatus,
  DeviceFamily,
  EngineUpdateStatus,
  ExtensionConfig,
  ProxyConfig,
  UpdateStatus,
} from "@multizen/types";

/** Payload for the `extensions:installed` push (companion "Add to MultiZen"). */
export type ExtensionInstalledEvent =
  | { ok: true; profileId: string; extension: ExtensionConfig }
  | { ok: false; profileId: string; error: string };

export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
  /** Round-trip time (ms) of the test request through the proxy. */
  latencyMs?: number;
}

/** Mirror of the catalog types from @multizen/profile-manager. */
export interface DeviceCatalogEntry {
  family: DeviceFamily;
  label: string;
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
}
export interface LocaleCatalogEntry {
  id: string;
  label: string;
  locale: string;
  country: string;
  timezones: ReadonlyArray<string>;
}
export interface FingerprintReconcilePatch {
  device?: DeviceFamily;
  localeId?: string;
  screen?: { width: number; height: number };
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

interface SystemInfo {
  mcpHttpUrl: string | null;
  appVersion: string;
  platform: NodeJS.Platform;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

const api = {
  profiles: {
    list: (): Promise<ProfileSummary[]> => ipcRenderer.invoke("profiles:list"),
    get: (id: ProfileId): Promise<Profile | null> => ipcRenderer.invoke("profiles:get", id),
    create: (input: CreateProfileInput): Promise<Profile> =>
      ipcRenderer.invoke("profiles:create", input),
    update: (id: ProfileId, patch: UpdateProfileInput): Promise<Profile> =>
      ipcRenderer.invoke("profiles:update", id, patch),
    delete: (id: ProfileId): Promise<void> => ipcRenderer.invoke("profiles:delete", id),
    launch: (id: ProfileId): Promise<LaunchedProfile> =>
      ipcRenderer.invoke("profiles:launch", id),
    close: (id: ProfileId): Promise<void> => ipcRenderer.invoke("profiles:close", id),
    exportArchive: (
      id: ProfileId,
      passphrase: string,
    ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> =>
      ipcRenderer.invoke("profiles:export", id, passphrase),
    importArchive: (
      passphrase: string,
    ): Promise<{ ok: true; id: ProfileId } | { ok: false; reason: string }> =>
      ipcRenderer.invoke("profiles:import", passphrase),
    onRunningChanged: (cb: (change: RunningStateChange) => void): (() => void) => {
      const listener = (_: unknown, change: RunningStateChange): void => cb(change);
      ipcRenderer.on("profiles:running-changed", listener);
      return () => ipcRenderer.off("profiles:running-changed", listener);
    },
    onProxyCountryUpdated: (
      cb: (update: { id: string; country: string }) => void,
    ): (() => void) => {
      const listener = (
        _: unknown,
        update: { id: string; country: string },
      ): void => cb(update);
      ipcRenderer.on("profiles:proxy-country-updated", listener);
      return () => ipcRenderer.off("profiles:proxy-country-updated", listener);
    },
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke("settings:update", patch),
  },
  activity: {
    recent: (): Promise<ActivityEvent[]> => ipcRenderer.invoke("activity:recent"),
    onEvent: (cb: (e: ActivityEvent) => void): (() => void) => {
      const listener = (_: unknown, e: ActivityEvent): void => cb(e);
      ipcRenderer.on("activity:event", listener);
      return () => ipcRenderer.off("activity:event", listener);
    },
  },
  system: {
    info: (): Promise<SystemInfo> => ipcRenderer.invoke("system:info"),
    /**
     * Open an external URL in the OS default browser. The main process
     * ALLOWLISTS the exact target (https://irensaltali.com); any other URL is
     * rejected there, so the renderer can never open arbitrary schemes/hosts.
     */
    openExternal: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("system:openExternal", url),
  },
  chromium: {
    status: (): Promise<ChromiumStatus> => ipcRenderer.invoke("chromium:status"),
    retry: (): Promise<ChromiumStatus> => ipcRenderer.invoke("chromium:retry"),
    onStatus: (cb: (status: ChromiumStatus) => void): (() => void) => {
      const listener = (_: unknown, status: ChromiumStatus): void => cb(status);
      ipcRenderer.on("chromium:status", listener);
      return () => ipcRenderer.off("chromium:status", listener);
    },
  },
  extensions: {
    list: (profileId: string): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:list", profileId),
    addFromFile: (profileId: string): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:addFromFile", profileId),
    addFromFolder: (profileId: string): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:addFromFolder", profileId),
    addFromWebStore: (profileId: string, urlOrId: string): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:addFromWebStore", profileId, urlOrId),
    remove: (profileId: string, extId: string): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:remove", profileId, extId),
    toggle: (profileId: string, extId: string, enabled: boolean): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:toggle", profileId, extId, enabled),
    // Staging (create sheet, no profile id yet).
    storeEntries: (): Promise<ExtensionConfig[]> =>
      ipcRenderer.invoke("extensions:storeEntries"),
    prepareFromWebStore: (urlOrId: string): Promise<ExtensionConfig> =>
      ipcRenderer.invoke("extensions:prepareFromWebStore", urlOrId),
    prepareFromFile: (): Promise<ExtensionConfig | null> =>
      ipcRenderer.invoke("extensions:prepareFromFile"),
    prepareFromFolder: (): Promise<ExtensionConfig | null> =>
      ipcRenderer.invoke("extensions:prepareFromFolder"),
    /** Real icon from the extension's manifest, as a data URI (or null). */
    icon: (ext: ExtensionConfig, profileId: string | null): Promise<string | null> =>
      ipcRenderer.invoke("extensions:icon", ext, profileId),
    onInstalled: (cb: (e: ExtensionInstalledEvent) => void): (() => void) => {
      const listener = (_: unknown, e: ExtensionInstalledEvent): void => cb(e);
      ipcRenderer.on("extensions:installed", listener);
      return () => ipcRenderer.off("extensions:installed", listener);
    },
  },
  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:status"),
    lastChecked: (): Promise<number> => ipcRenderer.invoke("update:lastChecked"),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:check"),
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    download: (version: string): Promise<void> =>
      ipcRenderer.invoke("update:download", version),
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_: unknown, status: UpdateStatus): void => cb(status);
      ipcRenderer.on("update:status", listener);
      return () => ipcRenderer.off("update:status", listener);
    },
  },
  engineUpdate: {
    status: (): Promise<EngineUpdateStatus> => ipcRenderer.invoke("engine-update:status"),
    check: (): Promise<EngineUpdateStatus> => ipcRenderer.invoke("engine-update:check"),
    install: (): Promise<EngineUpdateStatus> => ipcRenderer.invoke("engine-update:install"),
    onStatus: (cb: (status: EngineUpdateStatus) => void): (() => void) => {
      const listener = (_: unknown, status: EngineUpdateStatus): void => cb(status);
      ipcRenderer.on("engine-update:status", listener);
      return () => ipcRenderer.off("engine-update:status", listener);
    },
  },
  fingerprint: {
    generate: (): Promise<FingerprintConfig> =>
      ipcRenderer.invoke("fingerprint:generate"),
    devices: (): Promise<ReadonlyArray<DeviceCatalogEntry>> =>
      ipcRenderer.invoke("fingerprint:devices"),
    locales: (): Promise<ReadonlyArray<LocaleCatalogEntry>> =>
      ipcRenderer.invoke("fingerprint:locales"),
    reconcile: (
      current: FingerprintConfig,
      patch: FingerprintReconcilePatch,
    ): Promise<FingerprintConfig> =>
      ipcRenderer.invoke("fingerprint:reconcile", current, patch),
    localeForCountry: (cc: string): Promise<string | null> =>
      ipcRenderer.invoke("fingerprint:localeForCountry", cc),
  },
  proxy: {
    detectGeo: (
      proxy: ProxyConfig,
      profileId?: string,
    ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> =>
      ipcRenderer.invoke("proxy:detectGeo", proxy, profileId),
  },
  sync: {
    diagnostics: (): Promise<SyncOpResult<SyncDiagnostics>> =>
      ipcRenderer.invoke("sync:diagnostics"),
    exportDiagnostics: (profileId?: string): Promise<SyncOpResult<SyncDiagnosticsExport>> =>
      ipcRenderer.invoke("sync:exportDiagnostics", profileId),
    exportDiagnosticsToFile: (
      profileId?: string,
    ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke("sync:exportDiagnosticsToFile", profileId),
    getConfig: (): Promise<SyncConfigView> => ipcRenderer.invoke("sync:getConfig"),
    updateConfig: (patch: Partial<SyncConfigView>): Promise<SyncOpResult<SyncConfigView>> =>
      ipcRenderer.invoke("sync:updateConfig", patch),
    saveSecret: (kind: SecretKind, value: string): Promise<SyncOpResult> =>
      ipcRenderer.invoke("sync:saveSecret", kind, value),
    deleteSecret: (kind: SecretKind): Promise<SyncOpResult> =>
      ipcRenderer.invoke("sync:deleteSecret", kind),
    testCoordination: (): Promise<SyncOpResult<StorageTestResult>> =>
      ipcRenderer.invoke("sync:testCoordination"),
    status: (profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:status", profileId),
    enable: (
      profileId: string,
      enabled: boolean,
    ): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:enable", profileId, enabled),
    acquire: (profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:acquire", profileId),
    release: (profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:release", profileId),
    backup: (profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:backup", profileId),
    restore: (
      profileId: string,
      keepLocalAsConflict: boolean,
    ): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:restore", profileId, keepLocalAsConflict),
    connectExisting: (profileId: string): Promise<SyncOpResult<{ profileId: string }>> =>
      ipcRenderer.invoke("sync:connectExisting", profileId),
    bootstrapStatus: (): Promise<SyncOpResult<BootstrapSummary>> =>
      ipcRenderer.invoke("sync:bootstrapStatus"),
    syncAll: (): Promise<SyncOpResult<BootstrapSummary>> => ipcRenderer.invoke("sync:syncAll"),
    disableAndDeleteRemote: (
      profileId: string,
    ): Promise<SyncOpResult<DisableProfileSyncResult>> =>
      ipcRenderer.invoke("sync:disableAndDeleteRemote", profileId),
    reEnable: (profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      ipcRenderer.invoke("sync:reEnable", profileId),
    onProgress: (cb: (e: SyncProgressEvent) => void): (() => void) => {
      const listener = (_: unknown, e: SyncProgressEvent): void => cb(e);
      ipcRenderer.on("sync:progress", listener);
      return () => ipcRenderer.off("sync:progress", listener);
    },
  },
  /**
   * MCP gateway projects: upstream servers, an exclusive browser-profile
   * binding, local directories, and the agent configuration files MultiZen
   * writes into them.
   *
   * Secret discipline mirrors the sync API: `saveManagedSecret` is WRITE-ONLY
   * (there is no counterpart that returns a value), and `generateToken` is the
   * ONLY method that ever returns a secret — a freshly minted bearer token, once,
   * at the operator's explicit request.
   */
  gateway: {
    // ── projects ──────────────────────────────────────────────────────────
    listProjects: (): Promise<GatewayOpResult<ProjectView[]>> =>
      ipcRenderer.invoke("gateway:listProjects"),
    getProject: (id: string): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:getProject", id),
    createProject: (input: CreateProjectInput): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:createProject", input),
    updateProject: (
      id: string,
      patch: UpdateProjectInput,
    ): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:updateProject", id, patch),
    deleteProject: (id: string): Promise<GatewayOpResult<{ deleted: string }>> =>
      ipcRenderer.invoke("gateway:deleteProject", id),
    /** One-shot guided setup: create, add a server, link directories, enable. */
    setupProject: (
      input: ProjectSetupInput,
    ): Promise<GatewayOpResult<ProjectSetupResultView>> =>
      ipcRenderer.invoke("gateway:setupProject", input),

    // ── exclusive browser-profile binding ─────────────────────────────────
    bindProfile: (
      id: string,
      profileId: string | null,
    ): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:bindProfile", id, profileId),
    bindableProfiles: (
      forProjectId?: string,
    ): Promise<GatewayOpResult<BindableProfileView[]>> =>
      ipcRenderer.invoke("gateway:bindableProfiles", forProjectId),

    // ── upstream servers ──────────────────────────────────────────────────
    addServer: (id: string, input: ServerInput): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:addServer", id, input),
    updateServer: (id: string, input: ServerInput): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:updateServer", id, input),
    removeServer: (id: string, serverId: string): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:removeServer", id, serverId),
    setServerEnabled: (
      id: string,
      serverId: string,
      enabled: boolean,
    ): Promise<GatewayOpResult<ProjectView>> =>
      ipcRenderer.invoke("gateway:setServerEnabled", id, serverId, enabled),
    restartServer: (id: string, serverId: string): Promise<GatewayOpResult<undefined>> =>
      ipcRenderer.invoke("gateway:restartServer", id, serverId),
    /**
     * Try a server definition's connection without saving it. `secretValues` on
     * the input are used for this attempt only and are not stored. Pass a null
     * project id while a project is still being created.
     */
    testServer: (
      id: string | null,
      input: ServerInput,
    ): Promise<GatewayOpResult<ProbeResultView>> =>
      ipcRenderer.invoke("gateway:testServer", id, input),

    // ── project route authentication ──────────────────────────────────────
    setAuthEnabled: (id: string, enabled: boolean): Promise<GatewayOpResult<LocalAuthView>> =>
      ipcRenderer.invoke("gateway:setAuthEnabled", id, enabled),
    authStatus: (id: string): Promise<GatewayOpResult<LocalAuthView>> =>
      ipcRenderer.invoke("gateway:authStatus", id),
    /** Mints and returns a NEW token exactly once; it is never readable again. */
    generateToken: (id: string): Promise<GatewayOpResult<{ token: string }>> =>
      ipcRenderer.invoke("gateway:generateToken", id),

    // ── endpoints + runtime ───────────────────────────────────────────────
    endpoints: (id: string): Promise<GatewayOpResult<ProjectEndpointsView>> =>
      ipcRenderer.invoke("gateway:endpoints", id),
    runtime: (id: string): Promise<GatewayOpResult<ProjectRuntimeView>> =>
      ipcRenderer.invoke("gateway:runtime", id),

    // ── `${NAME}` references (names + presence only) ───────────────────────
    secretRefs: (id: string): Promise<GatewayOpResult<SecretRefStatusView[]>> =>
      ipcRenderer.invoke("gateway:secretRefs", id),
    approveEnvName: (name: string): Promise<GatewayOpResult<undefined>> =>
      ipcRenderer.invoke("gateway:approveEnvName", name),
    revokeEnvName: (name: string): Promise<GatewayOpResult<undefined>> =>
      ipcRenderer.invoke("gateway:revokeEnvName", name),
    /** WRITE-ONLY: stores the value in OS secure storage; never read back. */
    saveManagedSecret: (
      id: string,
      name: string,
      value: string,
    ): Promise<GatewayOpResult<SecretRefStatusView[]>> =>
      ipcRenderer.invoke("gateway:saveManagedSecret", id, name, value),
    deleteManagedSecret: (
      id: string,
      name: string,
    ): Promise<GatewayOpResult<SecretRefStatusView[]>> =>
      ipcRenderer.invoke("gateway:deleteManagedSecret", id, name),

    // ── local directories + agent configuration ───────────────────────────
    /** Native folder chooser; resolves to an absolute path or null. */
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("gateway:pickDirectory"),
    directories: (id: string): Promise<GatewayOpResult<WorkspaceBindingView[]>> =>
      ipcRenderer.invoke("gateway:directories", id),
    setDirectoryAgents: (
      id: string,
      directory: string,
      agents: readonly AgentKind[],
    ): Promise<GatewayOpResult<WorkspaceBindingView[]>> =>
      ipcRenderer.invoke("gateway:setDirectoryAgents", id, directory, agents),
    removeDirectory: (
      id: string,
      directory: string,
    ): Promise<GatewayOpResult<WorkspaceBindingView[]>> =>
      ipcRenderer.invoke("gateway:removeDirectory", id, directory),
    reconcileDirectories: (id: string): Promise<GatewayOpResult<ReconcileResultView>> =>
      ipcRenderer.invoke("gateway:reconcileDirectories", id),
    retryDirectoryAgent: (
      id: string,
      directory: string,
      agent: AgentKind,
    ): Promise<GatewayOpResult<WorkspaceBindingView[]>> =>
      ipcRenderer.invoke("gateway:retryDirectoryAgent", id, directory, agent),
    revealPath: (target: string): Promise<GatewayOpResult<undefined>> =>
      ipcRenderer.invoke("gateway:revealPath", target),
  },
};

contextBridge.exposeInMainWorld("multizen", api);

export type MultizenApi = typeof api;
