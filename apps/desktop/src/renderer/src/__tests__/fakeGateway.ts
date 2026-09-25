import { vi } from "vitest";

import type {
  AgentKind,
  BindableProfileView,
  GatewayOpResult,
  MultizenApi,
  ConflictView,
  CredentialBackupView,
  ProjectHistoryEntryView,
  ProjectRollbackView,
  CredentialRestoreView,
  SetupFromBackupInput,
  SetupResultView,
  SetupStageView,
  GatewaySyncStatusView,
  ProbeResultView,
  ProjectView,
  QuarantineView,
  SecretRefStatusView,
  ServerInput,
  ServerView,
  TrustDeviceView,
  WorkspaceBindingView,
} from "../types";

/**
 * An in-memory stand-in for `window.multizen.gateway`.
 *
 * Renderer tests drive the UI through the SAME preload contract production uses,
 * so a component can never accidentally reach into main-process modules. The
 * fake keeps just enough state to make multi-step flows (create → add server →
 * link a directory → enable) behave like the real backend, and every method is a
 * `vi.fn()` so tests can assert on the exact calls a component made.
 *
 * It deliberately mirrors the real redaction contract: no method returns a
 * managed secret value, and `generateToken` is the only one that returns a token.
 */

export interface FakeGatewayState {
  projects: Map<string, ProjectView>;
  directories: Map<string, WorkspaceBindingView[]>;
  secretRefs: Map<string, SecretRefStatusView[]>;
  /** Current sync status, mutated by syncRetry so a retry is observable. */
  sync: GatewaySyncStatusView;
  /** Trust roster, mutated by approve/revoke so the flow is observable. */
  devices: TrustDeviceView[];
  conflicts: ConflictView[];
  quarantined: QuarantineView[];
  /** Records every resolution choice, so tests can assert the exact intent. */
  resolutions: Array<{ projectId: string; keep: "mine" | "theirs" }>;
  profiles: BindableProfileView[];
  /** Values passed to saveManagedSecret, so tests can prove they never leak. */
  savedSecrets: Array<{ projectId: string; name: string; value: string }>;
  /** Per-project revision history, newest first, keyed by project id. */
  history: Map<string, ProjectHistoryEntryView[]>;
  /** Every rollback request, so tests can assert the exact revision asked for. */
  rollbacks: Array<{ projectId: string; revision: number }>;
  /** Credential-backup state, mutated by enable/disable so the flow is observable. */
  credentialBackup: CredentialBackupView;
  /**
   * Every set-up-from-backup call, so tests can assert the exact input the wizard
   * sent — including that a skipped credential passphrase is genuinely omitted.
   */
  setupRuns: SetupFromBackupInput[];
  /** Live progress subscribers, so the fake can replay a stage stream. */
  setupListeners: Array<(stage: SetupStageView) => void>;
  /**
   * Every passphrase handed to the backup channels. Tests assert on these to
   * prove the UI sends what was typed — and that nothing reads one back.
   */
  passphrases: Array<{ op: "enable" | "restore"; passphrase: string }>;
}

/**
 * A plausible all-green setup result derived from the input: the credentials stage
 * is "skipped" when no passphrase was supplied, mirroring the real flow, so a UI
 * test cannot pass by ignoring that distinction.
 */
function defaultSetupResult(input: SetupFromBackupInput): SetupResultView {
  const done = (id: string): SetupStageView => ({ id, status: "done", detail: null });
  return {
    ok: true,
    stages: [
      { ...done("storage"), detail: "Storage reachable and safe for coordination." },
      { ...done("trust"), detail: "Trust registry adopted; this device is trusted." },
      { ...done("settings"), detail: "Shared preferences restored." },
      { ...done("projects"), detail: "2 projects restored." },
      { ...done("bindings"), detail: "1 folder relinked." },
      input.credentialPassphrase === undefined
        ? {
            id: "credentials",
            status: "skipped" as const,
            detail: "No credential passphrase given — server secrets were not restored.",
          }
        : { ...done("credentials"), detail: "3 credentials restored for alpha." },
      { ...done("profiles"), detail: "2 profiles restored." },
    ],
    deviceId: "device_fake",
    canPublish: true,
    awaitingApproval: false,
  };
}

/** Every `${NAME}` a server view references, across env values and headers. */
function serverRefNames(server: ServerView): string[] {
  const out = new Set<string>();
  const scan = (v: string): void => {
    for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1] as string);
  };
  if (server.transport === "stdio") {
    for (const v of Object.values(server.env ?? {})) scan(v);
  } else {
    scan(server.url);
    for (const v of Object.values(server.headers ?? {})) scan(v);
  }
  return [...out];
}

function ok<T>(value: T): GatewayOpResult<T> {
  return { ok: true, value };
}
function err(code: string, message: string): GatewayOpResult<never> {
  return { ok: false, error: { code, message } };
}

/** A minimal ProjectView with sane defaults. */
export function project(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    enabled: true,
    localAuth: { enabled: false, tokenPresent: false },
    servers: [],
    ...over,
  };
}

/** One directory binding view with the given agents, all "current". */
export function binding(
  projectId: string,
  directory: string,
  agents: readonly AgentKind[],
  over: Partial<WorkspaceBindingView> = {},
): WorkspaceBindingView {
  return {
    projectId,
    directory,
    agents: agents.map((agent) => ({
      agent,
      status: "current" as const,
      configPath: `${directory}/${agent}.config`,
      lastInstalledAt: 1_700_000_000_000,
    })),
    ...over,
  };
}

export interface FakeGateway {
  readonly api: MultizenApi["gateway"];
  /**
   * The slice of `window.multizen.profiles` the Projects UI touches. Only
   * `create` is modelled — the wizard's inline profile creation goes through the
   * real preload contract, so it must not reach for anything else.
   */
  readonly profilesApi: Pick<MultizenApi["profiles"], "create">;
  readonly state: FakeGatewayState;
}

export function createFakeGateway(
  initial: {
    projects?: readonly ProjectView[];
    profiles?: readonly BindableProfileView[];
    directories?: Readonly<Record<string, WorkspaceBindingView[]>>;
    secretRefs?: Readonly<Record<string, SecretRefStatusView[]>>;
    /** Force listProjects to fail, for error-state tests. */
    failList?: string;
    /** Absolute path the native picker returns, or null to simulate cancel. */
    pickResult?: string | null;
    /** Force profiles.create to reject, for error-path tests. */
    failProfileCreate?: string;
    /** Fixed result for testServer, so probe outcomes can be driven. */
    probeResult?: ProbeResultView;
    /** Initial sync status. Defaults to a not-configured gateway. */
    sync?: Partial<GatewaySyncStatusView>;
    /** Status syncRetry resolves to, simulating a successful re-compose. */
    syncAfterRetry?: Partial<GatewaySyncStatusView>;
    /** Initial trust roster, including any `pending` announcements. */
    devices?: readonly TrustDeviceView[];
    conflicts?: readonly ConflictView[];
    quarantined?: readonly QuarantineView[];
    /** Initial credential-backup state. Defaults to off, syncing, nothing stored. */
    credentialBackup?: Partial<CredentialBackupView>;
    /** Force enableCredentialBackup to fail with this envelope. */
    failEnableCredentialBackup?: { code: string; message: string };
    /** Force restoreCredentials to fail with this envelope. */
    failRestoreCredentials?: { code: string; message: string };
    /** Result restoreCredentials resolves to on success. */
    restoreResult?: CredentialRestoreView;
    /**
     * `${NAME}` references that do NOT resolve, so a server mentioning one is
     * held back. Lets a test reproduce the env-error state the UI reports.
     */
    unresolvedRefs?: readonly string[];
    /** Per-project revision history, keyed by project id. */
    history?: Readonly<Record<string, ProjectHistoryEntryView[]>>;
    /** Force restoreProjectRevision to fail with this envelope. */
    failRollback?: { code: string; message: string };
    /** Force setupFromBackup to fail with this envelope. */
    failSetup?: { code: string; message: string };
    /** Fixed result setupFromBackup resolves to, overriding the default. */
    setupResult?: SetupResultView;
  } = {},
): FakeGateway {
  const state: FakeGatewayState = {
    projects: new Map((initial.projects ?? []).map((p) => [p.id, p])),
    directories: new Map(Object.entries(initial.directories ?? {})),
    secretRefs: new Map(Object.entries(initial.secretRefs ?? {})),
    profiles: [...(initial.profiles ?? [])],
    savedSecrets: [],
    passphrases: [],
    history: new Map(Object.entries(initial.history ?? {})),
    rollbacks: [],
    setupRuns: [],
    setupListeners: [],
    credentialBackup: {
      enabled: false,
      localCount: 0,
      remotePresent: false,
      remoteIssue: null,
      syncing: true,
      minPassphraseLength: 12,
      ...initial.credentialBackup,
    },
    devices: [...(initial.devices ?? [])],
    conflicts: [...(initial.conflicts ?? [])],
    quarantined: [...(initial.quarantined ?? [])],
    resolutions: [],
    sync: {
      ready: false,
      lastSyncAt: null,
      lastError: null,
      applied: 0,
      quarantined: 0,
      conflicts: 0,
      running: false,
      ...initial.sync,
    },
  };

  const requireProject = (id: string): ProjectView | null => state.projects.get(id) ?? null;

  const api: MultizenApi["gateway"] = {
    listProjects: vi.fn(async () =>
      initial.failList !== undefined
        ? err("io", initial.failList)
        : ok([...state.projects.values()]),
    ),
    getProject: vi.fn(async (id: string) => {
      const p = requireProject(id);
      return p ? ok(p) : err("not-found", `project ${id} not found`);
    }),
    createProject: vi.fn(async (input) => {
      if (state.projects.has(input.id)) {
        return err("conflict", `project ${input.id} already exists`);
      }
      const held = state.profiles.find(
        (x) => x.profileId === input.browserProfileId && x.boundToProjectId !== undefined,
      );
      if (held?.boundToProjectId !== undefined) {
        return err(
          `profile-bound:${held.boundToProjectId}`,
          `already bound to ${held.boundToProjectId}`,
        );
      }
      const created = project(input.id, {
        ...(input.label !== undefined ? { label: input.label } : {}),
        enabled: input.enabled ?? false,
        ...(input.browserProfileId !== undefined
          ? { browserProfileId: input.browserProfileId }
          : {}),
      });
      state.projects.set(created.id, created);
      return ok(created);
    }),
    updateProject: vi.fn(async (id, patch) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      if (typeof patch.browserProfileId === "string") {
        const held = state.profiles.find(
          (x) =>
            x.profileId === patch.browserProfileId &&
            x.boundToProjectId !== undefined &&
            x.boundToProjectId !== id,
        );
        if (held?.boundToProjectId !== undefined) {
          return err(
            `profile-bound:${held.boundToProjectId}`,
            `already bound to ${held.boundToProjectId}`,
          );
        }
      }
      const next: ProjectView = {
        ...current,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      };
      const withBinding =
        patch.browserProfileId === undefined
          ? next
          : patch.browserProfileId === null
            ? (({ browserProfileId: _drop, ...rest }) => rest as ProjectView)(next)
            : { ...next, browserProfileId: patch.browserProfileId };
      state.projects.set(id, withBinding);
      return ok(withBinding);
    }),
    deleteProject: vi.fn(async (id: string) => {
      state.projects.delete(id);
      state.directories.delete(id);
      return ok({ deleted: id });
    }),
    setupProject: vi.fn(async (input) => {
      const created = await api.createProject({
        id: input.id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        enabled: false,
        ...(typeof input.browserProfileId === "string"
          ? { browserProfileId: input.browserProfileId }
          : {}),
      });
      if (!created.ok) return created;
      if (input.server) await api.addServer(input.id, input.server);
      for (const d of input.directories ?? []) {
        await api.setDirectoryAgents(input.id, d.directory, d.agents);
      }
      if (input.enableWhenReady !== false) {
        await api.updateProject(input.id, { enabled: true });
      }
      const project = await api.getProject(input.id);
      if (!project.ok) return project;
      const bindings = state.directories.get(input.id) ?? [];
      return ok({
        project: project.value,
        reconcile: { projectId: input.id, allCurrent: true, bindings },
        enabled: project.value.enabled,
      });
    }),

    bindProfile: vi.fn(async (id, profileId) =>
      api.updateProject(id, { browserProfileId: profileId }),
    ),
    bindableProfiles: vi.fn(async (forProjectId?: string) =>
      ok(
        state.profiles.map((p) => ({
          ...p,
          available: p.boundToProjectId === undefined || p.boundToProjectId === forProjectId,
        })),
      ),
    ),

    addServer: vi.fn(async (id: string, input: ServerInput) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      if (current.servers.some((s) => s.id === input.id)) {
        return err("invalid", `server ${input.id} already exists`);
      }
      const next = { ...current, servers: [...current.servers, toServerView(input)] };
      state.projects.set(id, next);
      return ok(next);
    }),
    updateServer: vi.fn(async (id: string, input: ServerInput) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      const next = {
        ...current,
        servers: current.servers.map((s) => (s.id === input.id ? toServerView(input) : s)),
      };
      state.projects.set(id, next);
      return ok(next);
    }),
    removeServer: vi.fn(async (id: string, serverId: string) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      const next = { ...current, servers: current.servers.filter((s) => s.id !== serverId) };
      state.projects.set(id, next);
      return ok(next);
    }),
    setServerEnabled: vi.fn(async (id: string, serverId: string, enabled: boolean) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      const next = {
        ...current,
        servers: current.servers.map((s) => (s.id === serverId ? { ...s, disabled: !enabled } : s)),
      };
      state.projects.set(id, next);
      return ok(next);
    }),
    restartServer: vi.fn(async () => ok(undefined)),
    testServer: vi.fn(async (_id: string | null, input: ServerInput) => {
      if (initial.probeResult !== undefined) return ok(initial.probeResult);
      // The default stand-in succeeds, and echoes the id so a test can prove the
      // probe was handed the definition currently in the form.
      return ok({
        ok: true as const,
        serverName: `${input.id}-server`,
        serverVersion: "1.0.0",
        toolCount: 2,
        toolNames: ["alpha", "beta"],
        durationMs: 42,
      });
    }),

    setAuthEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      const localAuth = {
        enabled,
        ...(enabled ? { tokenRef: "${MULTIZEN_PROJECT_TOKEN}" } : {}),
        tokenPresent: current.localAuth.tokenPresent,
      };
      state.projects.set(id, { ...current, localAuth });
      return ok(localAuth);
    }),
    authStatus: vi.fn(async (id: string) => {
      const current = requireProject(id);
      return current ? ok(current.localAuth) : err("not-found", `project ${id} not found`);
    }),
    generateToken: vi.fn(async (id: string) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      state.projects.set(id, {
        ...current,
        localAuth: { ...current.localAuth, tokenPresent: true },
      });
      return ok({ token: "f".repeat(64) });
    }),

    endpoints: vi.fn(async (id: string) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      return ok({
        projectId: id,
        baseUrl: "http://127.0.0.1:7777",
        proxies: current.servers.map((s) => ({
          serverId: s.id,
          url: `http://127.0.0.1:7777/mcp/proxies/${id}/${s.id}`,
        })),
        ...(current.browserProfileId !== undefined
          ? { browser: `http://127.0.0.1:7777/mcp/projects/${id}/browser` }
          : {}),
        authRequired: current.localAuth.enabled,
        served: true,
      });
    }),
    runtime: vi.fn(async (id: string) => {
      const current = requireProject(id);
      if (!current) return err("not-found", `project ${id} not found`);
      const unresolved = new Set(initial.unresolvedRefs ?? []);
      return ok({
        projectId: id,
        enabled: current.enabled,
        bootstrapped: current.enabled,
        servers: current.servers.map((s) => {
          // Mirrors GatewayRuntime: a server that is off (or whose project is off)
          // never attempts resolution, so it reports NO missing references. Getting
          // this wrong in the fake would hide the very bug it needs to catch.
          const off = s.disabled === true || !current.enabled;
          const missingEnv = off ? [] : serverRefNames(s).filter((n) => unresolved.has(n));
          return {
            projectId: id,
            serverId: s.id,
            transport: s.transport,
            phase: off
              ? ("disabled" as const)
              : missingEnv.length > 0
                ? ("env-error" as const)
                : s.transport === "stdio"
                  ? ("running" as const)
                  : ("connected" as const),
            restarts: 0,
            consecutiveFailures: 0,
            missingEnv,
            sessions: 0,
          };
        }),
      });
    }),

    secretRefs: vi.fn(async (id: string) => ok(state.secretRefs.get(id) ?? [])),
    approveEnvName: vi.fn(async () => ok(undefined)),
    revokeEnvName: vi.fn(async () => ok(undefined)),
    saveManagedSecret: vi.fn(async (id: string, name: string, value: string) => {
      state.savedSecrets.push({ projectId: id, name, value });
      const refs = (state.secretRefs.get(id) ?? []).map((r) =>
        r.name === name ? { ...r, managed: true, present: true, source: "managed" as const } : r,
      );
      state.secretRefs.set(id, refs);
      return ok(refs);
    }),
    deleteManagedSecret: vi.fn(async (id: string, name: string) => {
      const refs = (state.secretRefs.get(id) ?? []).map((r) =>
        r.name === name ? { ...r, managed: false, present: false, source: null } : r,
      );
      state.secretRefs.set(id, refs);
      return ok(refs);
    }),

    pickDirectory: vi.fn(async () =>
      initial.pickResult === undefined ? "/abs/picked" : initial.pickResult,
    ),
    directories: vi.fn(async (id: string) => ok(state.directories.get(id) ?? [])),
    setDirectoryAgents: vi.fn(
      async (id: string, directory: string, agents: readonly AgentKind[]) => {
        const existing = (state.directories.get(id) ?? []).filter((b) => b.directory !== directory);
        const next =
          agents.length === 0
            ? existing
            : [...existing, binding(id, directory, agents)].sort((a, b) =>
                a.directory.localeCompare(b.directory),
              );
        state.directories.set(id, next);
        return ok(next);
      },
    ),
    removeDirectory: vi.fn(async (id: string, directory: string) => {
      const next = (state.directories.get(id) ?? []).filter((b) => b.directory !== directory);
      state.directories.set(id, next);
      return ok(next);
    }),
    reconcileDirectories: vi.fn(async (id: string) =>
      ok({ projectId: id, allCurrent: true, bindings: state.directories.get(id) ?? [] }),
    ),
    retryDirectoryAgent: vi.fn(async (id: string) => ok(state.directories.get(id) ?? [])),
    revealPath: vi.fn(async () => ok(undefined)),

    conflicts: vi.fn(async () => ok(state.conflicts)),
    resolveConflicts: vi.fn(async (projectId: string, keep: "mine" | "theirs") => {
      state.resolutions.push({ projectId, keep });
      state.conflicts = state.conflicts.filter((c) => c.projectId !== projectId);
      return ok(undefined);
    }),
    quarantine: vi.fn(async () => ok(state.quarantined)),
    releaseQuarantine: vi.fn(async (projectId: string) => {
      state.quarantined = state.quarantined.filter((q) => q.projectId !== projectId);
      return ok(undefined);
    }),

    trustList: vi.fn(async () => ok(state.devices)),
    approveDevice: vi.fn(async (deviceId: string, publicKeyHex: string) => {
      state.devices = [
        ...state.devices.filter((d) => d.deviceId !== deviceId),
        { deviceId, publicKeyHex, role: "trusted" as const, isSelf: false },
      ];
      if (state.credentialBackup.remoteIssue?.deviceId === deviceId) {
        state.credentialBackup = {
          ...state.credentialBackup,
          remotePresent: true,
          remoteIssue: null,
        };
      }
      return ok(undefined);
    }),
    revokeDevice: vi.fn(async (deviceId: string) => {
      state.devices = state.devices.map((d) =>
        d.deviceId === deviceId ? { ...d, role: "revoked" as const } : d,
      );
      return ok(undefined);
    }),
    renameDevice: vi.fn(async (name: string) => {
      state.devices = state.devices.map((d) => (d.isSelf ? { ...d, name } : d));
      return ok(undefined);
    }),

    syncStatus: vi.fn(async () => ok(state.sync)),
    syncRetry: vi.fn(async () => {
      // Mirrors the real controller: re-compose, run a pass, return the status.
      state.sync = {
        ...state.sync,
        ready: true,
        lastSyncAt: 1_700_000_000_000,
        lastError: null,
        ...initial.syncAfterRetry,
      };
      return ok(state.sync);
    }),

    projectHistory: vi.fn(async (id: string) => {
      if (!state.projects.has(id) && !state.history.has(id)) {
        return err("not-found", `project ${id} not found`);
      }
      return ok(state.history.get(id) ?? []);
    }),
    restoreProjectRevision: vi.fn(async (id: string, revision: number) => {
      state.rollbacks.push({ projectId: id, revision });
      if (initial.failRollback) return err(initial.failRollback.code, initial.failRollback.message);
      const entries = state.history.get(id) ?? [];
      const top = entries.reduce((m, e) => Math.max(m, e.revision), 0);
      const next = top + 1;
      // Mirrors the real backend: the old content becomes a NEW revision, and the
      // timeline grows rather than rewinding.
      state.history.set(id, [
        {
          revision: next,
          archivedAt: new Date().toISOString(),
          signer: "device_fake",
          deleted: false,
          current: true,
        },
        ...entries.map((e) => ({ ...e, current: false })),
      ]);
      return ok({ revision: next, fromRevision: revision } satisfies ProjectRollbackView);
    }),

    onSetupProgress: vi.fn((cb: (stage: SetupStageView) => void) => {
      state.setupListeners.push(cb);
      return () => {
        state.setupListeners = state.setupListeners.filter((l) => l !== cb);
      };
    }),
    setupFromBackup: vi.fn(async (input: SetupFromBackupInput) => {
      state.setupRuns.push(input);
      // Replay the stages as live progress before resolving, exactly as the main
      // process does, so a UI relying on the stream is genuinely exercised.
      const result = initial.setupResult ?? defaultSetupResult(input);
      for (const stage of result.stages) {
        for (const l of state.setupListeners) l({ ...stage, status: "running", detail: null });
        for (const l of state.setupListeners) l(stage);
      }
      if (initial.failSetup) return err(initial.failSetup.code, initial.failSetup.message);
      return ok(result);
    }),

    credentialBackup: vi.fn(async () => ok(state.credentialBackup)),
    enableCredentialBackup: vi.fn(async (passphrase: string) => {
      state.passphrases.push({ op: "enable", passphrase });
      if (initial.failEnableCredentialBackup) {
        return err(
          initial.failEnableCredentialBackup.code,
          initial.failEnableCredentialBackup.message,
        );
      }
      state.credentialBackup = {
        ...state.credentialBackup,
        enabled: true,
        remotePresent: true,
      };
      return ok(state.credentialBackup);
    }),
    disableCredentialBackup: vi.fn(async () => {
      state.credentialBackup = {
        ...state.credentialBackup,
        enabled: false,
        remotePresent: false,
      };
      return ok(state.credentialBackup);
    }),
    replaceCredentialBackup: vi.fn(async () => {
      state.credentialBackup = {
        ...state.credentialBackup,
        remotePresent: true,
        remoteIssue: null,
      };
      return ok(state.credentialBackup);
    }),
    restoreCredentials: vi.fn(async (passphrase: string) => {
      state.passphrases.push({ op: "restore", passphrase });
      if (initial.failRestoreCredentials) {
        return err(initial.failRestoreCredentials.code, initial.failRestoreCredentials.message);
      }
      return ok(initial.restoreResult ?? { restored: 2, projects: ["proj1"] });
    }),
  };

  let profileSeq = 0;
  const profilesApi: FakeGateway["profilesApi"] = {
    // The real handler rejects rather than returning an envelope, so the fake
    // rejects too — the wizard must survive a thrown IPC error.
    create: vi.fn(async (input) => {
      if (initial.failProfileCreate !== undefined) {
        throw new Error(initial.failProfileCreate);
      }
      profileSeq += 1;
      const created = { id: `new-profile-${profileSeq}`, name: input.name };
      state.profiles.push({ profileId: created.id, name: created.name, available: true });
      // Only `id` and `name` are read by the UI; the rest of Profile (dataDir,
      // generated fingerprint, timestamps) is the main process's business.
      return created as unknown as Awaited<ReturnType<MultizenApi["profiles"]["create"]>>;
    }),
  };

  return { api, profilesApi, state };
}

function toServerView(input: ServerInput) {
  if (input.transport === "stdio") {
    return {
      transport: "stdio" as const,
      id: input.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      disabled: input.disabled ?? false,
      command: input.command,
      args: [...(input.args ?? [])],
      env: { ...(input.env ?? {}) },
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    };
  }
  return {
    transport: "streamable-http" as const,
    id: input.id,
    ...(input.label !== undefined ? { label: input.label } : {}),
    disabled: input.disabled ?? false,
    url: input.url,
    headers: { ...(input.headers ?? {}) },
  };
}

/**
 * Install a fake gateway (and the minimum of the rest of the preload surface a
 * screen may touch) onto `window.multizen` for one test.
 */
export function installFakeGateway(fake: FakeGateway): void {
  const existing = (window as unknown as { multizen?: Partial<MultizenApi> }).multizen ?? {};
  (window as unknown as { multizen: Partial<MultizenApi> }).multizen = {
    ...existing,
    gateway: fake.api,
    profiles: {
      ...(existing.profiles ?? {}),
      ...fake.profilesApi,
    } as MultizenApi["profiles"],
  };
}
