/**
 * GatewayController — the serializable API surface behind the gateway IPC.
 *
 * Translates verified {@link ProjectConfig}s to redacted {@link ProjectView}s
 * (env/header values become reference NAMES only; tokens/private keys are never
 * returned) and applies strict, validated input mutations back through the
 * {@link GatewayService}. Every method returns a {@link GatewayOpResult} and
 * never throws across the boundary.
 *
 * Redaction invariants (mirrors the Cloud Sync controller):
 *   - env maps expose the child-visible name -> `${NAME}` reference verbatim
 *     (the reference is the safe persisted form; it is NOT an expanded secret).
 *   - header maps expose name -> `${NAME}` reference verbatim.
 *   - local-auth exposes only `enabled` + `tokenPresent` + the `${NAME}` ref;
 *     never the token value. A freshly generated token is revealed ONCE by the
 *     explicit generate endpoint and never persisted in any view.
 */

import {
  CONFIG_VERSION,
  isEnvName,
  parseProjectConfig,
  type ProjectConfig,
  type ServerConfig,
} from "@multizen/mcp-gateway";

import type { GatewayService } from "./GatewayService.ts";
import { ConfigFileError } from "./ConfigFileTransactor.ts";
import { projectTokenEnvName } from "./agentAdapters.ts";
import { managedRefName } from "./GatewayVault.ts";
import { AGENT_KINDS } from "./types.ts";
import type {
  AgentKind,
  BindableProfileView,
  ConflictView,
  CreateProjectInput,
  GatewayOpResult,
  GatewaySyncStatusView,
  HttpServerView,
  LocalAuthView,
  ProbeResultView,
  ProjectEndpointsView,
  ProjectRuntimeView,
  ProjectSetupInput,
  ProjectSetupResultView,
  ProjectView,
  QuarantineView,
  ReconcileResultView,
  RuntimeLogView,
  SecretRefStatusView,
  ServerInput,
  ServerRuntimeView,
  ServerView,
  StdioServerView,
  TrustDeviceView,
  UpdateProjectInput,
  WorkspaceBindingView,
} from "./types.ts";

function ok<T>(value: T): GatewayOpResult<T> {
  return { ok: true, value };
}
function fail(code: string, message: string): GatewayOpResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Convert a filesystem/adapter failure into a serializable envelope, keeping the
 * actionable hint so the UI can tell the operator what to fix.
 */
function failFromFileError(err: unknown): GatewayOpResult<never> {
  if (err instanceof ConfigFileError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.hint !== undefined ? `${err.message} — ${err.hint}` : err.message,
      },
    };
  }
  return fail("io", err instanceof Error ? err.message : String(err));
}

/**
 * A browser profile can belong to only one project. The conflicting project is
 * named in both the code and the message so the UI can link straight to it.
 */
function profileConflict(conflictProjectId: string): GatewayOpResult<never> {
  return {
    ok: false,
    error: {
      code: `profile-bound:${conflictProjectId}`,
      message:
        `That browser profile is already bound to the project “${conflictProjectId}”. ` +
        `A profile can belong to only one project — unbind it there first.`,
    },
  };
}

/** Map a stored ServerConfig to its redacted view. */
function serverView(s: ServerConfig): ServerView {
  if (s.transport === "stdio") {
    const v: StdioServerView = {
      transport: "stdio",
      id: s.id,
      ...(s.label !== undefined ? { label: s.label } : {}),
      disabled: s.disabled,
      command: s.command,
      args: [...s.args],
      env: { ...s.env },
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    };
    return v;
  }
  const v: HttpServerView = {
    transport: "streamable-http",
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    disabled: s.disabled,
    url: s.url,
    headers: { ...s.headers },
  };
  return v;
}

/** Convert a validated ServerInput to a ServerConfig (parse enforces refs). */
function serverInputToConfig(input: ServerInput): ServerConfig {
  if (input.transport === "stdio") {
    return {
      transport: "stdio",
      id: input.id as ServerConfig["id"],
      ...(input.label !== undefined ? { label: input.label } : {}),
      disabled: input.disabled ?? false,
      command: input.command,
      args: input.args ? [...input.args] : [],
      env: { ...(input.env ?? {}) },
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    } as ServerConfig;
  }
  return {
    transport: "streamable-http",
    id: input.id as ServerConfig["id"],
    ...(input.label !== undefined ? { label: input.label } : {}),
    disabled: input.disabled ?? false,
    url: input.url,
    headers: { ...(input.headers ?? {}) },
  } as ServerConfig;
}

export interface GatewayControllerOptions {
  /** Base URL the endpoints view uses, e.g. "http://127.0.0.1:7777". */
  readonly baseUrl: string;
  /**
   * True when the gateway's HTTP routes are actually being served. The gateway
   * service runs even with the MCP HTTP transport disabled (so projects and
   * agent files stay manageable), so the UI must be told when the endpoint URLs
   * are informational rather than live.
   */
  readonly routesServed: () => boolean;
}

export class GatewayController {
  private readonly baseUrl: string;
  private readonly routesServed: () => boolean;

  constructor(
    private readonly service: GatewayService,
    options: GatewayControllerOptions,
  ) {
    this.baseUrl = options.baseUrl;
    this.routesServed = options.routesServed;
  }

  private authView(config: ProjectConfig, tokenPresent: boolean): LocalAuthView {
    return {
      enabled: config.localAuth.enabled,
      ...(config.localAuth.tokenRef !== undefined ? { tokenRef: config.localAuth.tokenRef } : {}),
      tokenPresent,
    };
  }

  private async projectView(config: ProjectConfig): Promise<ProjectView> {
    const tokenPresent = await this.service.vaultAdapter.hasProjectToken(config.id);
    return {
      id: config.id,
      ...(config.label !== undefined ? { label: config.label } : {}),
      enabled: config.enabled,
      ...(config.browserProfileId !== undefined
        ? { browserProfileId: config.browserProfileId }
        : {}),
      localAuth: this.authView(config, tokenPresent),
      servers: config.servers.map(serverView),
    };
  }

  // ── project CRUD ──────────────────────────────────────────────────────

  async listProjects(): Promise<GatewayOpResult<ProjectView[]>> {
    const views = await Promise.all(
      this.service.allConfigs().map((c) => this.projectView(c)),
    );
    return ok(views);
  }

  async getProject(projectId: string): Promise<GatewayOpResult<ProjectView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    return ok(await this.projectView(config));
  }

  async createProject(input: CreateProjectInput): Promise<GatewayOpResult<ProjectView>> {
    if (this.service.configOf(input.id)) {
      return fail("conflict", `project ${input.id} already exists`);
    }
    let config: ProjectConfig;
    try {
      config = parseProjectConfig({
        configVersion: CONFIG_VERSION,
        id: input.id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        enabled: input.enabled ?? false,
        ...(input.browserProfileId !== undefined
          ? { browserProfileId: input.browserProfileId }
          : {}),
        localAuth: { enabled: false },
        servers: [],
      });
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
    // A browser profile belongs to at most one project; check and claim it
    // atomically so two concurrent creates cannot both take it.
    const guarded = await this.service.applyWithBindingGuard(
      input.id,
      input.browserProfileId,
      () => this.service.saveConfig(config),
    );
    if (!guarded.ok) return profileConflict(guarded.conflictProjectId);
    return ok(await this.projectView(config));
  }

  async updateProject(
    projectId: string,
    patch: UpdateProjectInput,
  ): Promise<GatewayOpResult<ProjectView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const bindingChanged =
      patch.browserProfileId !== undefined &&
      patch.browserProfileId !== (config.browserProfileId ?? null);
    let rebuilt: ProjectConfig;
    try {
      const next = parseProjectConfig({
        ...toRaw(config),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.browserProfileId !== undefined
          ? patch.browserProfileId === null
            ? {}
            : { browserProfileId: patch.browserProfileId }
          : {}),
      });
      // parseProjectConfig drops browserProfileId when omitted; when clearing,
      // rebuild without it (toRaw includes it, so delete explicitly).
      rebuilt = patch.browserProfileId === null ? stripBinding(next) : next;
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
    const guarded = await this.service.applyWithBindingGuard(
      projectId,
      patch.browserProfileId,
      () => this.service.saveConfig(rebuilt),
    );
    if (!guarded.ok) return profileConflict(guarded.conflictProjectId);
    if (bindingChanged) await this.service.invalidateBoundServer(projectId);
    return ok(await this.projectView(rebuilt));
  }

  async deleteProject(
    projectId: string,
  ): Promise<GatewayOpResult<{ deleted: string }>> {
    if (!this.service.configOf(projectId)) {
      // Already gone: report success so a double-delete is not an error.
      return ok({ deleted: projectId });
    }
    const result = await this.service.deleteProjectSafely(projectId);
    if (!result.deleted) {
      const first = result.failures[0];
      return fail(
        "cleanup-failed",
        `MultiZen could not remove its entries from ${first?.agent ?? "an agent"} in ` +
          `${first?.directory ?? "a directory"}: ${first?.message ?? "unknown error"}. ` +
          `The project was kept so nothing is left orphaned — fix the file and delete again.`,
      );
    }
    // Deleting a project config NEVER deletes its bound browser profile.
    return ok({ deleted: projectId });
  }

  async bindProfile(
    projectId: string,
    browserProfileId: string | null,
  ): Promise<GatewayOpResult<ProjectView>> {
    return this.updateProject(projectId, { browserProfileId });
  }

  /**
   * Browser profiles offered for binding. A profile held by another project is
   * listed as unavailable with the holder named, so the UI can explain why.
   */
  bindableProfiles(forProjectId?: string): GatewayOpResult<BindableProfileView[]> {
    return ok(this.service.bindableProfiles(forProjectId));
  }

  /**
   * Guided setup: create a project, optionally add its first server, associate
   * directories with their agent selections, install, and only THEN enable it.
   *
   * The project is deliberately created DISABLED so nothing is served or written
   * from a half-configured state. It is enabled at the end only when the durable
   * save and every requested installation succeeded. A failed agent write leaves
   * the project in place, disabled, with a retryable per-target status rather
   * than rolling back work the operator already did.
   */
  async setupProject(
    input: ProjectSetupInput,
  ): Promise<GatewayOpResult<ProjectSetupResultView>> {
    const created = await this.createProject({
      id: input.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      // Always start disabled; enabling is the last step.
      enabled: false,
      ...(typeof input.browserProfileId === "string"
        ? { browserProfileId: input.browserProfileId }
        : {}),
    });
    if (!created.ok) return created;

    if (input.server !== undefined) {
      const added = await this.addServer(input.id, input.server);
      if (!added.ok) return added;
    }

    for (const binding of input.directories ?? []) {
      const res = await this.setDirectoryAgents(input.id, binding.directory, binding.agents);
      // A bad directory (missing, symlinked, unwritable) must not abort setup:
      // the project and its other directories stay, and this one is reported.
      if (!res.ok && res.error.code === "not-found") return res;
    }

    // Enable last, so the first reconcile that actually writes endpoints happens
    // with the project in its final, intended state.
    let enabled = false;
    if (input.enableWhenReady !== false) {
      const turnedOn = await this.updateProject(input.id, { enabled: true });
      if (!turnedOn.ok) return turnedOn;
      enabled = turnedOn.value.enabled;
    }

    const reconcile = await this.service.reconcileAgentConfigs(input.id);
    const project = await this.getProject(input.id);
    if (!project.ok) return project;
    return ok({ project: project.value, reconcile, enabled });
  }

  // ── server CRUD ───────────────────────────────────────────────────────

  async addServer(projectId: string, input: ServerInput): Promise<GatewayOpResult<ProjectView>> {
    const prepared = await this.withStoredSecrets(projectId, input);
    if (!prepared.ok) return prepared;
    return this.mutateServers(projectId, (servers) => {
      if (servers.some((s) => s.id === input.id)) {
        throw new Error(`server ${input.id} already exists`);
      }
      return [...servers, serverInputToConfig(prepared.value)];
    });
  }

  async updateServer(
    projectId: string,
    input: ServerInput,
  ): Promise<GatewayOpResult<ProjectView>> {
    const prepared = await this.withStoredSecrets(projectId, input);
    if (!prepared.ok) return prepared;
    return this.mutateServers(projectId, (servers) => {
      if (!servers.some((s) => s.id === input.id)) {
        throw new Error(`server ${input.id} not found`);
      }
      return servers.map((s) => (s.id === input.id ? serverInputToConfig(prepared.value) : s));
    });
  }

  /**
   * Move any raw values in `secretValues` into OS secure storage and return the
   * same input with those fields replaced by `${NAME}` references.
   *
   * Done BEFORE the config is built, so no code path downstream of here — config
   * validation, persistence, signing, sync, agent-file rendering — ever sees a
   * value. The project is checked first so a typo cannot leave secrets in the
   * keychain for a project that does not exist.
   */
  private async withStoredSecrets(
    projectId: string,
    input: ServerInput,
  ): Promise<GatewayOpResult<ServerInput>> {
    const values = input.secretValues ?? {};
    const keys = Object.keys(values);
    if (keys.length === 0) return ok(input);
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    for (const key of keys) {
      if (values[key] === "") {
        return fail("invalid", `no value was given for “${key}”`);
      }
    }
    let refs: Record<string, string>;
    try {
      refs = await this.service.storeInlineSecrets(projectId, input.id, values);
    } catch (err) {
      return fail(
        "vault",
        `the value for “${keys[0]}” could not be stored securely: ${(err as Error).message}`,
      );
    }
    // Drop secretValues on the way out: what continues is references only.
    const { secretValues: _stored, ...rest } = input;
    return ok(
      rest.transport === "stdio"
        ? { ...rest, env: { ...(rest.env ?? {}), ...refs } }
        : { ...rest, headers: { ...(rest.headers ?? {}), ...refs } },
    );
  }

  async removeServer(projectId: string, serverId: string): Promise<GatewayOpResult<ProjectView>> {
    return this.mutateServers(projectId, (servers) => servers.filter((s) => s.id !== serverId));
  }

  async setServerEnabled(
    projectId: string,
    serverId: string,
    enabled: boolean,
  ): Promise<GatewayOpResult<ProjectView>> {
    return this.mutateServers(projectId, (servers) =>
      servers.map((s) => (s.id === serverId ? { ...s, disabled: !enabled } : s)),
    );
  }

  async restartServer(projectId: string, serverId: string): Promise<GatewayOpResult<undefined>> {
    await this.service.runtime.restartServer(projectId, serverId);
    return ok(undefined);
  }

  /**
   * Test a server definition's connection without saving anything.
   *
   * Raw values in `secretValues` are used for this attempt only and are NOT
   * stored, so a test can be run, adjusted, and re-run before the operator
   * commits. Crucially the derived reference names are computed exactly as
   * {@link withStoredSecrets} computes them, so a definition that passes here is
   * byte-for-byte the definition that gets saved — a green test cannot be
   * followed by a save that behaves differently.
   *
   * `projectId` may be null while a project is still being created; existing
   * stored values simply are not available to draw on in that case.
   */
  async testServer(
    projectId: string | null,
    input: ServerInput,
  ): Promise<GatewayOpResult<ProbeResultView>> {
    const refs: Record<string, string> = {};
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.secretValues ?? {})) {
      const name = managedRefName(input.id, key);
      refs[key] = `\${${name}}`;
      overrides[name] = value;
    }
    const { secretValues: _unsaved, ...rest } = input;
    const withRefs: ServerInput =
      rest.transport === "stdio"
        ? { ...rest, env: { ...(rest.env ?? {}), ...refs } }
        : { ...rest, headers: { ...(rest.headers ?? {}), ...refs } };
    try {
      const server = serverInputToConfig(withRefs);
      return ok(await this.service.testServerConnection(projectId, server, overrides));
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  private async mutateServers(
    projectId: string,
    fn: (servers: ServerConfig[]) => ServerConfig[],
  ): Promise<GatewayOpResult<ProjectView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    try {
      const nextServers = fn([...config.servers]);
      const raw = { ...toRaw(config), servers: nextServers.map(serverToRaw) };
      const next = parseProjectConfig(raw);
      await this.service.saveConfig(next);
      return ok(await this.projectView(next));
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  // ── auth toggle / token ────────────────────────────────────────────────

  async setAuthEnabled(
    projectId: string,
    enabled: boolean,
  ): Promise<GatewayOpResult<LocalAuthView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    try {
      const raw = toRaw(config);
      raw.localAuth = enabled
        ? {
            enabled: true,
            // The SAME deterministic variable name the agent adapters emit, so
            // the operator sees exactly what their agent must have exported.
            tokenRef: `\${${projectTokenEnvName(projectId)}}`,
          }
        : { enabled: false };
      const next = parseProjectConfig(raw);
      await this.service.saveConfig(next);
      const present = await this.service.vaultAdapter.hasProjectToken(projectId);
      return ok(this.authView(next, present));
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  /**
   * Generate a fresh device-local bearer token for a project. Returns the token
   * ONCE (explicit one-shot reveal) so the operator can copy it into a client;
   * it is not persisted in any view and future reads only report presence.
   */
  async generateToken(projectId: string): Promise<GatewayOpResult<{ token: string }>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    const token = await this.service.vaultAdapter.generateProjectToken(projectId);
    return ok({ token });
  }

  async authStatus(projectId: string): Promise<GatewayOpResult<LocalAuthView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const present = await this.service.vaultAdapter.hasProjectToken(projectId);
    return ok(this.authView(config, present));
  }

  // ── endpoints / runtime / logs ───────────────────────────────────────────

  endpoints(projectId: string): GatewayOpResult<ProjectEndpointsView> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const proxies = config.servers.map((s) => ({
      serverId: s.id,
      url: `${this.baseUrl}/mcp/proxies/${config.id}/${s.id}`,
    }));
    return ok({
      projectId: config.id,
      baseUrl: this.baseUrl,
      proxies,
      ...(config.browserProfileId !== undefined
        ? { browser: `${this.baseUrl}/mcp/projects/${config.id}/browser` }
        : {}),
      authRequired: config.localAuth.enabled,
      served: this.routesServed(),
    });
  }

  runtime(projectId: string): GatewayOpResult<ProjectRuntimeView> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const all = this.service.runtime.status();
    const servers: ServerRuntimeView[] = all
      .filter((s) => s.projectId === projectId)
      .map((s) => ({
        projectId: s.projectId,
        serverId: s.serverId,
        transport: s.transport,
        phase: s.phase as ServerRuntimeView["phase"],
        restarts: s.restarts,
        consecutiveFailures: s.consecutiveFailures,
        ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
        missingEnv: [...s.missingEnv],
        sessions: s.sessions,
      }));
    return ok({
      projectId: config.id,
      enabled: config.enabled,
      bootstrapped: servers.some((s) => s.phase === "running" || s.phase === "connected"),
      servers,
    });
  }

  /** Redacted bounded stderr / lifecycle logs for a server. */
  logs(projectId: string, serverId: string): GatewayOpResult<RuntimeLogView[]> {
    const lines = this.service.runtime.serverLogs(projectId, serverId);
    const now = Date.now();
    return ok(
      lines.map((line) => ({ projectId, serverId, at: now, line })),
    );
  }

  // ── local directories + agent configuration ─────────────────────────────

  /** Directory associations and per-agent install state for a project. */
  async directories(projectId: string): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    return ok(await this.service.workspaceBindings(projectId));
  }

  /**
   * Associate a directory with the project and set which agents it installs.
   * An empty agent list keeps the directory but installs nothing.
   */
  async setDirectoryAgents(
    projectId: string,
    directory: string,
    agents: readonly AgentKind[],
  ): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    const selection = agents.filter((a): a is AgentKind =>
      (AGENT_KINDS as readonly string[]).includes(a),
    );
    if (selection.length !== agents.length) {
      return fail("invalid", "unknown agent in selection");
    }
    try {
      await this.service.setDirectoryAgents(projectId, directory, selection);
      return ok(await this.service.workspaceBindings(projectId));
    } catch (err) {
      return failFromFileError(err);
    }
  }

  /** Unlink a directory, first removing MultiZen's entries from its files. */
  async removeDirectory(
    projectId: string,
    directory: string,
  ): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    try {
      await this.service.removeDirectory(projectId, directory);
      return ok(await this.service.workspaceBindings(projectId));
    } catch (err) {
      return failFromFileError(err);
    }
  }

  /** Re-install the project into every associated directory. */
  async reconcileDirectories(
    projectId: string,
  ): Promise<GatewayOpResult<ReconcileResultView>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    return ok(await this.service.reconcileAgentConfigs(projectId));
  }

  /** Retry one failed directory+agent target. */
  async retryDirectoryAgent(
    projectId: string,
    directory: string,
    agent: AgentKind,
  ): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    try {
      await this.service.retryAgentInstall(projectId, directory, agent);
      return ok(await this.service.workspaceBindings(projectId));
    } catch (err) {
      return failFromFileError(err);
    }
  }

  // ── `${NAME}` references: availability + provisioning ────────────────────
  /**
   * Availability of every `${NAME}` the project references. Returns NAMES,
   * sources, and presence booleans ONLY — never a value.
   */
  async secretRefs(projectId: string): Promise<GatewayOpResult<SecretRefStatusView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    return ok(await this.service.secretRefStatus(projectId));
  }

  /** Approve reading one environment NAME on this device. */
  async approveEnvName(name: string): Promise<GatewayOpResult<undefined>> {
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    await this.service.approveEnvName(name);
    return ok(undefined);
  }

  /** Revoke an environment approval (may deactivate dependent servers). */
  async revokeEnvName(name: string): Promise<GatewayOpResult<undefined>> {
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    await this.service.revokeEnvName(name);
    return ok(undefined);
  }

  /**
   * Store the value backing one reference in OS secure storage. WRITE-ONLY:
   * there is no counterpart that returns the value. An empty value is refused
   * so a secret cannot be silently blanked.
   */
  async saveManagedSecret(
    projectId: string,
    name: string,
    value: string,
  ): Promise<GatewayOpResult<SecretRefStatusView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    if (typeof value !== "string" || value.length === 0) {
      return fail("invalid", "value must be a non-empty string");
    }
    await this.service.saveManagedSecret(projectId, name, value);
    return ok(await this.service.secretRefStatus(projectId));
  }

  /** Remove a managed value (may deactivate dependent servers). */
  async deleteManagedSecret(
    projectId: string,
    name: string,
  ): Promise<GatewayOpResult<SecretRefStatusView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    await this.service.deleteManagedSecret(projectId, name);
    return ok(await this.service.secretRefStatus(projectId));
  }

  // ── trust ────────────────────────────────────────────────────────────

  async trustList(): Promise<GatewayOpResult<TrustDeviceView[]>> {
    const bridge = this.service.syncBridge;
    if (!bridge) return ok([]);
    const registry = await bridge.fetchTrustRegistry().catch(() => null);
    if (!registry) return ok([]);
    const selfId = await this.service.vaultAdapter.deviceId();
    return ok(
      registry.entries.map((e) => ({
        deviceId: e.deviceId,
        publicKeyHex: e.publicKeyHex,
        role: e.role,
        isSelf: e.deviceId === selfId,
      })),
    );
  }

  async approveDevice(
    deviceId: string,
    publicKeyHex: string,
  ): Promise<GatewayOpResult<undefined>> {
    const bridge = this.service.syncBridge;
    if (!bridge) return fail("unavailable", "Cloud Sync is not ready");
    try {
      const current = await bridge.fetchTrustRegistry();
      const entries = current ? [...current.entries] : [];
      const filtered = entries.filter((e) => e.deviceId !== deviceId);
      filtered.push({
        deviceId,
        publicKeyHex: publicKeyHex as never,
        role: "trusted",
      });
      await bridge.approveDevice(filtered);
      return ok(undefined);
    } catch (err) {
      return fail("trust", (err as Error).message);
    }
  }

  async revokeDevice(deviceId: string): Promise<GatewayOpResult<undefined>> {
    const bridge = this.service.syncBridge;
    if (!bridge) return fail("unavailable", "Cloud Sync is not ready");
    try {
      const current = await bridge.fetchTrustRegistry();
      if (!current) return fail("not-found", "no trust registry");
      const entries = current.entries.map((e) =>
        e.deviceId === deviceId ? { ...e, role: "revoked" as const } : e,
      );
      await bridge.approveDevice(entries);
      return ok(undefined);
    } catch (err) {
      return fail("trust", (err as Error).message);
    }
  }

  // ── conflicts / quarantine / sync ────────────────────────────────────────

  conflicts(): GatewayOpResult<ConflictView[]> {
    return ok(this.service.conflictList());
  }

  async resolveConflicts(projectId: string): Promise<GatewayOpResult<undefined>> {
    await this.service.resolveConflicts(projectId);
    return ok(undefined);
  }

  quarantine(): GatewayOpResult<QuarantineView[]> {
    return ok(this.service.quarantineList());
  }

  async releaseQuarantine(projectId: string): Promise<GatewayOpResult<undefined>> {
    await this.service.releaseQuarantine(projectId);
    return ok(undefined);
  }

  syncStatus(): GatewayOpResult<GatewaySyncStatusView> {
    return ok(this.service.syncStatusView());
  }

  async syncRetry(): Promise<GatewayOpResult<GatewaySyncStatusView>> {
    await this.service.composeSyncIfReady();
    await this.service.syncNow();
    return ok(this.service.syncStatusView());
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** A mutable raw JSON object from a validated config (round-trips through parse). */
function toRaw(config: ProjectConfig): Record<string, unknown> {
  return {
    configVersion: config.configVersion,
    id: config.id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    enabled: config.enabled,
    ...(config.browserProfileId !== undefined
      ? { browserProfileId: config.browserProfileId }
      : {}),
    localAuth: {
      enabled: config.localAuth.enabled,
      ...(config.localAuth.tokenRef !== undefined ? { tokenRef: config.localAuth.tokenRef } : {}),
    },
    servers: config.servers.map(serverToRaw),
  };
}

function serverToRaw(s: ServerConfig): Record<string, unknown> {
  if (s.transport === "stdio") {
    return {
      transport: "stdio",
      id: s.id,
      ...(s.label !== undefined ? { label: s.label } : {}),
      disabled: s.disabled,
      command: s.command,
      args: [...s.args],
      env: { ...s.env },
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    };
  }
  return {
    transport: "streamable-http",
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    disabled: s.disabled,
    url: s.url,
    headers: { ...s.headers },
  };
}

/** Rebuild a config without its browserProfileId (clearing a binding). */
function stripBinding(config: ProjectConfig): ProjectConfig {
  const raw = toRaw(config);
  delete raw.browserProfileId;
  return parseProjectConfig(raw);
}
