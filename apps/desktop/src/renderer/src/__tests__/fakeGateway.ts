import { vi } from "vitest";

import type {
  AgentKind,
  BindableProfileView,
  GatewayOpResult,
  MultizenApi,
  ProbeResultView,
  ProjectView,
  SecretRefStatusView,
  ServerInput,
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
  profiles: BindableProfileView[];
  /** Values passed to saveManagedSecret, so tests can prove they never leak. */
  savedSecrets: Array<{ projectId: string; name: string; value: string }>;
}

function ok<T>(value: T): GatewayOpResult<T> {
  return { ok: true, value };
}
function err(code: string, message: string): GatewayOpResult<never> {
  return { ok: false, error: { code, message } };
}

/** A minimal ProjectView with sane defaults. */
export function project(
  id: string,
  over: Partial<ProjectView> = {},
): ProjectView {
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
  } = {},
): FakeGateway {
  const state: FakeGatewayState = {
    projects: new Map((initial.projects ?? []).map((p) => [p.id, p])),
    directories: new Map(Object.entries(initial.directories ?? {})),
    secretRefs: new Map(Object.entries(initial.secretRefs ?? {})),
    profiles: [...(initial.profiles ?? [])],
    savedSecrets: [],
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
          available:
            p.boundToProjectId === undefined || p.boundToProjectId === forProjectId,
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
        servers: current.servers.map((s) =>
          s.id === serverId ? { ...s, disabled: !enabled } : s,
        ),
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
      return ok({
        projectId: id,
        enabled: current.enabled,
        bootstrapped: current.enabled,
        servers: current.servers.map((s) => ({
          projectId: id,
          serverId: s.id,
          transport: s.transport,
          phase: s.disabled
            ? ("disabled" as const)
            : s.transport === "stdio"
              ? ("running" as const)
              : ("connected" as const),
          restarts: 0,
          consecutiveFailures: 0,
          missingEnv: [],
          sessions: 0,
        })),
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
        const existing = (state.directories.get(id) ?? []).filter(
          (b) => b.directory !== directory,
        );
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
