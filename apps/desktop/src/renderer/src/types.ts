import type {
  CreateProfileInput,
  ProfileId,
  ProfileSummary,
  Profile,
  ProxyConfig,
  FingerprintConfig,
  UpdateProfileInput,
  LaunchedProfile,
  ChromiumStatus,
  DeviceFamily,
  UpdateStatus,
  EngineUpdateStatus,
  ExtensionConfig,
} from "@multizen/types";

/** Payload for the `extensions:installed` push (companion "Add to MultiZen"). */
export type ExtensionInstalledEvent =
  | { ok: true; profileId: string; extension: ExtensionConfig }
  | { ok: false; profileId: string; error: string };

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
export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
  /** Round-trip time (ms) of the test request through the proxy. */
  latencyMs?: number;
}
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
  BootstrapProfileResult,
  DisableProfileSyncResult,
} from "../../main/sync/types";
import type {
  AgentInstallStateView,
  AgentInstallStatus,
  AgentKind,
  BindableProfileView,
  CreateProjectInput,
  GatewayOpResult,
  HttpServerInput,
  HttpServerView,
  LocalAuthView,
  ProbeResultView,
  ProjectEndpointsView,
  ProjectRuntimeView,
  ProjectSetupInput,
  ProjectSetupResultView,
  ProjectView,
  ReconcileResultView,
  SecretRefStatusView,
  SecretSource,
  ServerInput,
  ServerRuntimeView,
  ServerView,
  StdioServerInput,
  StdioServerView,
  UpdateProjectInput,
  WorkspaceBindingInput,
  WorkspaceBindingView,
} from "../../main/mcp-gateway/types";

export interface SystemInfo {
  mcpHttpUrl: string | null;
  mcpAuthToken: string | null;
  appVersion: string;
  platform: string;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

export interface MultizenApi {
  profiles: {
    list: () => Promise<ProfileSummary[]>;
    get: (id: ProfileId) => Promise<Profile | null>;
    create: (input: CreateProfileInput) => Promise<Profile>;
    update: (id: ProfileId, patch: UpdateProfileInput) => Promise<Profile>;
    delete: (id: ProfileId) => Promise<void>;
    launch: (id: ProfileId) => Promise<LaunchedProfile>;
    close: (id: ProfileId) => Promise<void>;
    exportArchive: (
      id: ProfileId,
      passphrase: string,
    ) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
    importArchive: (
      passphrase: string,
    ) => Promise<{ ok: true; id: ProfileId } | { ok: false; reason: string }>;
    onRunningChanged: (cb: (change: RunningStateChange) => void) => () => void;
    onProxyCountryUpdated: (
      cb: (update: { id: string; country: string }) => void,
    ) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  activity: {
    recent: () => Promise<ActivityEvent[]>;
    onEvent: (cb: (e: ActivityEvent) => void) => () => void;
  };
  system: {
    info: () => Promise<SystemInfo>;
    openExternal: (url: string) => Promise<{ ok: boolean }>;
  };
  chromium: {
    status: () => Promise<ChromiumStatus>;
    retry: () => Promise<ChromiumStatus>;
    onStatus: (cb: (s: ChromiumStatus) => void) => () => void;
  };
  extensions: {
    list: (profileId: string) => Promise<ExtensionConfig[]>;
    addFromFile: (profileId: string) => Promise<ExtensionConfig[]>;
    addFromFolder: (profileId: string) => Promise<ExtensionConfig[]>;
    addFromWebStore: (profileId: string, urlOrId: string) => Promise<ExtensionConfig[]>;
    remove: (profileId: string, extId: string) => Promise<ExtensionConfig[]>;
    toggle: (profileId: string, extId: string, enabled: boolean) => Promise<ExtensionConfig[]>;
    /** Staging (create sheet, no profile id yet). */
    storeEntries: () => Promise<ExtensionConfig[]>;
    prepareFromWebStore: (urlOrId: string) => Promise<ExtensionConfig>;
    prepareFromFile: () => Promise<ExtensionConfig | null>;
    prepareFromFolder: () => Promise<ExtensionConfig | null>;
    /** Real icon from the extension's manifest, as a data URI (or null). */
    icon: (ext: ExtensionConfig, profileId: string | null) => Promise<string | null>;
    onInstalled: (cb: (e: ExtensionInstalledEvent) => void) => () => void;
  };
  update: {
    status: () => Promise<UpdateStatus>;
    lastChecked: () => Promise<number>;
    check: () => Promise<UpdateStatus>;
    install: () => Promise<void>;
    download: (version: string) => Promise<void>;
    onStatus: (cb: (s: UpdateStatus) => void) => () => void;
  };
  engineUpdate: {
    status: () => Promise<EngineUpdateStatus>;
    check: () => Promise<EngineUpdateStatus>;
    install: () => Promise<EngineUpdateStatus>;
    onStatus: (cb: (s: EngineUpdateStatus) => void) => () => void;
  };
  fingerprint: {
    generate: () => Promise<FingerprintConfig>;
    devices: () => Promise<ReadonlyArray<DeviceCatalogEntry>>;
    locales: () => Promise<ReadonlyArray<LocaleCatalogEntry>>;
    reconcile: (
      current: FingerprintConfig,
      patch: FingerprintReconcilePatch,
    ) => Promise<FingerprintConfig>;
    localeForCountry: (cc: string) => Promise<string | null>;
  };
  proxy: {
    detectGeo: (
      proxy: ProxyConfig,
      profileId?: string,
    ) => Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }>;
  };
  sync: {
    diagnostics: () => Promise<SyncOpResult<SyncDiagnostics>>;
    exportDiagnostics: (profileId?: string) => Promise<SyncOpResult<SyncDiagnosticsExport>>;
    exportDiagnosticsToFile: (
      profileId?: string,
    ) => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>;
    getConfig: () => Promise<SyncConfigView>;
    updateConfig: (patch: Partial<SyncConfigView>) => Promise<SyncOpResult<SyncConfigView>>;
    saveSecret: (kind: SecretKind, value: string) => Promise<SyncOpResult>;
    deleteSecret: (kind: SecretKind) => Promise<SyncOpResult>;
    testCoordination: () => Promise<SyncOpResult<StorageTestResult>>;
    status: (profileId: string) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    enable: (
      profileId: string,
      enabled: boolean,
    ) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    acquire: (profileId: string) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    release: (profileId: string) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    backup: (profileId: string) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    restore: (
      profileId: string,
      keepLocalAsConflict: boolean,
    ) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    connectExisting: (profileId: string) => Promise<SyncOpResult<{ profileId: string }>>;
    bootstrapStatus: () => Promise<SyncOpResult<BootstrapSummary>>;
    syncAll: () => Promise<SyncOpResult<BootstrapSummary>>;
    disableAndDeleteRemote: (
      profileId: string,
    ) => Promise<SyncOpResult<DisableProfileSyncResult>>;
    reEnable: (profileId: string) => Promise<SyncOpResult<ProfileSyncStatusView>>;
    onProgress: (cb: (e: SyncProgressEvent) => void) => () => void;
  };
  /**
   * MCP gateway projects. Mirrors the preload `gateway` namespace exactly; see
   * apps/desktop/src/preload/index.ts for the secret-handling contract.
   */
  gateway: {
    listProjects: () => Promise<GatewayOpResult<ProjectView[]>>;
    getProject: (id: string) => Promise<GatewayOpResult<ProjectView>>;
    createProject: (input: CreateProjectInput) => Promise<GatewayOpResult<ProjectView>>;
    updateProject: (
      id: string,
      patch: UpdateProjectInput,
    ) => Promise<GatewayOpResult<ProjectView>>;
    deleteProject: (id: string) => Promise<GatewayOpResult<{ deleted: string }>>;
    setupProject: (
      input: ProjectSetupInput,
    ) => Promise<GatewayOpResult<ProjectSetupResultView>>;

    bindProfile: (
      id: string,
      profileId: string | null,
    ) => Promise<GatewayOpResult<ProjectView>>;
    bindableProfiles: (
      forProjectId?: string,
    ) => Promise<GatewayOpResult<BindableProfileView[]>>;

    addServer: (id: string, input: ServerInput) => Promise<GatewayOpResult<ProjectView>>;
    updateServer: (id: string, input: ServerInput) => Promise<GatewayOpResult<ProjectView>>;
    removeServer: (id: string, serverId: string) => Promise<GatewayOpResult<ProjectView>>;
    setServerEnabled: (
      id: string,
      serverId: string,
      enabled: boolean,
    ) => Promise<GatewayOpResult<ProjectView>>;
    restartServer: (id: string, serverId: string) => Promise<GatewayOpResult<undefined>>;
    testServer: (
      id: string | null,
      input: ServerInput,
    ) => Promise<GatewayOpResult<ProbeResultView>>;

    setAuthEnabled: (id: string, enabled: boolean) => Promise<GatewayOpResult<LocalAuthView>>;
    authStatus: (id: string) => Promise<GatewayOpResult<LocalAuthView>>;
    generateToken: (id: string) => Promise<GatewayOpResult<{ token: string }>>;

    endpoints: (id: string) => Promise<GatewayOpResult<ProjectEndpointsView>>;
    runtime: (id: string) => Promise<GatewayOpResult<ProjectRuntimeView>>;

    secretRefs: (id: string) => Promise<GatewayOpResult<SecretRefStatusView[]>>;
    approveEnvName: (name: string) => Promise<GatewayOpResult<undefined>>;
    revokeEnvName: (name: string) => Promise<GatewayOpResult<undefined>>;
    saveManagedSecret: (
      id: string,
      name: string,
      value: string,
    ) => Promise<GatewayOpResult<SecretRefStatusView[]>>;
    deleteManagedSecret: (
      id: string,
      name: string,
    ) => Promise<GatewayOpResult<SecretRefStatusView[]>>;

    pickDirectory: () => Promise<string | null>;
    directories: (id: string) => Promise<GatewayOpResult<WorkspaceBindingView[]>>;
    setDirectoryAgents: (
      id: string,
      directory: string,
      agents: readonly AgentKind[],
    ) => Promise<GatewayOpResult<WorkspaceBindingView[]>>;
    removeDirectory: (
      id: string,
      directory: string,
    ) => Promise<GatewayOpResult<WorkspaceBindingView[]>>;
    reconcileDirectories: (id: string) => Promise<GatewayOpResult<ReconcileResultView>>;
    retryDirectoryAgent: (
      id: string,
      directory: string,
      agent: AgentKind,
    ) => Promise<GatewayOpResult<WorkspaceBindingView[]>>;
    revealPath: (target: string) => Promise<GatewayOpResult<undefined>>;
  };
}

declare global {
  interface Window {
    multizen: MultizenApi;
  }
}

export type {
  ActivityEvent,
  AppSettings,
  Profile,
  ProfileSummary,
  ProxyConfig,
  FingerprintConfig,
  LaunchedProfile,
  ChromiumStatus,
  DeviceFamily,
  UpdateStatus,
  EngineUpdateStatus,
  ExtensionConfig,
  UpdateProfileInput,
};

export type {
  ProfileSyncStatusView,
  SecretKind,
  StorageTestResult,
  SyncConfigView,
  SyncDiagnostics,
  SyncDiagnosticsExport,
  SyncOpResult,
  SyncProgressEvent,
  BootstrapSummary,
  BootstrapProfileResult,
  DisableProfileSyncResult,
};

// MCP gateway view/input types, re-exported so components import from one place.
export type {
  AgentInstallStateView,
  AgentInstallStatus,
  AgentKind,
  BindableProfileView,
  CreateProjectInput,
  GatewayOpResult,
  HttpServerInput,
  HttpServerView,
  LocalAuthView,
  ProbeResultView,
  ProjectEndpointsView,
  ProjectRuntimeView,
  ProjectSetupInput,
  ProjectSetupResultView,
  ProjectView,
  ReconcileResultView,
  SecretRefStatusView,
  SecretSource,
  ServerInput,
  ServerRuntimeView,
  ServerView,
  StdioServerInput,
  StdioServerView,
  UpdateProjectInput,
  WorkspaceBindingInput,
  WorkspaceBindingView,
};
