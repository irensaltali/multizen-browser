/**
 * Gateway runtime: desired-state reconciliation for one device's projects.
 *
 * Owns the live upstream connections and the relay fan-out. Given a set of
 * verified {@link ProjectConfig}s (the desired state), it:
 *
 *   - starts an enabled stdio server through the core {@link StdioSupervisor}
 *     (shell-free, backoff, circuit-breaker) and connects an enabled
 *     streamable-http server through the core {@link HttpConnector};
 *   - leaves a disabled project/server stopped;
 *   - on `reconcile`, diffs the new desired set against the running set and
 *     stops removed/disabled servers, starts newly-enabled ones, and restarts a
 *     server whose launch spec changed;
 *   - marks a server INACTIVE (never started) when its env references are
 *     missing/forbidden, surfacing the missing NAMES without ever resolving a
 *     secret into state;
 *   - multiplexes many downstream relay sessions onto one upstream transport
 *     via a per-server {@link UpstreamHub}; the relay's id ownership keeps
 *     sessions isolated;
 *   - on `shutdown`, closes every relay session and every upstream so no child
 *     process or SSE stream survives.
 *
 * Signature/trust verification is NOT done here — callers pass only configs
 * they have already verified. This is the honest "start what is trusted+enabled"
 * layer built on the core factories/supervisor/connectors, with no placeholders.
 */

import {
  buildBaseEnv,
  configHash,
  createHttpTransportFactory,
  createStdioTransportFactory,
  DEFAULT_BASE_ENV_ALLOW,
  EnvResolver,
  EnvResolutionError,
  HttpConnector,
  RelaySession,
  referencedEnvNames,
  StdioSupervisor,
  type ClientSink,
  type FetchLike,
  type GatewayTransport,
  type HttpServerConfig,
  type HttpTransportFactory,
  type JsonRpcMessage,
  type ProjectConfig,
  type ServerConfig,
  type StdioServerConfig,
  type StdioTransportFactory,
} from "@multizen/mcp-gateway";
import { createHash, randomBytes } from "node:crypto";

/** One upstream server's live runtime, keyed by `${projectId}/${serverId}`. */
interface ServerRuntime {
  readonly projectId: string;
  readonly serverId: string;
  readonly transport: "stdio" | "streamable-http";
  /** Hash of the server config that produced the current instance (restart diff). */
  configHash: string;
  /**
   * Fingerprint of the resolved reference VALUES the live instance was launched
   * with. Compared (never logged or exposed) so provisioning or rotating a
   * secret restarts the upstream. It is a salted digest, not the values.
   */
  resolvedHash: string;
  supervisor?: StdioSupervisor;
  connector?: HttpConnector;
  /** Fan-out of upstream messages to relay sessions. */
  hub: UpstreamHub;
  /** True when the server is disabled by desired state. */
  disabled: boolean;
  /** Env NAMES referenced but missing/forbidden — server is inactive. */
  missingEnv: string[];
  /** Redacted last error. */
  lastError?: string;
}

/**
 * Multiplexes one real upstream transport across many downstream relay sessions.
 * Each session registers a sink; every inbound upstream message is broadcast to
 * all sinks (the relay's per-session id ownership discards non-owned messages).
 * Session `send` calls forward to the single real transport.
 */
export class UpstreamHub {
  private readonly sinks = new Set<(m: JsonRpcMessage) => void>();
  private sender: ((m: JsonRpcMessage) => Promise<void>) | null = null;

  /** Wire the real transport's outbound sender (supervisor/connector.send). */
  setSender(send: (m: JsonRpcMessage) => Promise<void>): void {
    this.sender = send;
  }

  /** Called by the supervisor/connector for every message from the upstream. */
  dispatch(message: JsonRpcMessage): void {
    for (const sink of this.sinks) sink(message);
  }

  /** A per-session GatewayTransport view over the shared upstream. */
  view(): GatewayTransport {
    const self = this;
    let bound: ((m: JsonRpcMessage) => void) | undefined;
    const transport: GatewayTransport = {
      async start(): Promise<void> {
        /* upstream is started by the supervisor/connector */
      },
      async close(): Promise<void> {
        if (bound) self.sinks.delete(bound);
      },
      async send(message: JsonRpcMessage): Promise<void> {
        if (!self.sender) throw new Error("upstream not connected");
        await self.sender(message);
      },
    };
    Object.defineProperty(transport, "onmessage", {
      get: () => bound,
      set: (fn: ((m: JsonRpcMessage) => void) | undefined) => {
        if (bound) self.sinks.delete(bound);
        bound = fn;
        if (bound) self.sinks.add(bound);
      },
      configurable: true,
      enumerable: true,
    });
    return transport;
  }

  clear(): void {
    this.sinks.clear();
    this.sender = null;
  }
}

export interface GatewayRuntimeOptions {
  /** Allowlisted host env names a project may reference (beyond the base). */
  readonly envAllow?: readonly string[];
  /** Source of env values (defaults to process.env). */
  readonly envSource?: Readonly<Record<string, string | undefined>>;
  /** Injected stdio transport factory (tests). Defaults to the SDK factory. */
  readonly stdioFactory?: StdioTransportFactory;
  /** Injected http transport factory (tests). Defaults to the SDK factory. */
  readonly httpFactory?: HttpTransportFactory;
  /** Injected fetch for http connectors (tests). */
  readonly fetch?: FetchLike;
  /**
   * Resolves a project's `${NAME}` references to concrete values at launch time.
   * Defaults to an allowlisted read of {@link envSource}. The desktop injects a
   * resolver that prefers a MultiZen-managed vault value and otherwise reads an
   * operator-APPROVED process environment variable.
   */
  readonly secretResolver?: GatewaySecretResolver;
}

/**
 * Resolves `${NAME}` references for one project, immediately before an upstream
 * is launched or connected.
 *
 * Contract: return ONLY the names that resolved. An omitted name is reported as
 * missing and the server stays visible-inactive rather than starting with an
 * empty secret. Resolved values live in memory for the lifetime of the launch
 * and are never written back into any config, view, log, or agent file.
 */
export interface GatewaySecretResolver {
  resolve(
    projectId: string,
    names: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
}

/** Serializable runtime status for one server. */
export interface RuntimeServerStatus {
  readonly projectId: string;
  readonly serverId: string;
  readonly transport: "stdio" | "streamable-http";
  readonly phase: string;
  readonly restarts: number;
  readonly consecutiveFailures: number;
  readonly missingEnv: readonly string[];
  readonly sessions: number;
  readonly lastError?: string;
}

export class GatewayRuntime {
  private readonly servers = new Map<string, ServerRuntime>();
  /** Relay sessions keyed by downstream session id -> per-server relay. */
  private readonly sessions = new Map<string, { serverKey: string; relay: RelaySession }>();
  private readonly baseEnv: Readonly<Record<string, string>>;
  private readonly stdioFactory: StdioTransportFactory;
  private readonly httpFactory: HttpTransportFactory;
  private readonly fetch?: FetchLike;
  private readonly envSource: Readonly<Record<string, string | undefined>>;
  private readonly envAllow: readonly string[];
  private readonly secretResolver: GatewaySecretResolver;

  constructor(options: GatewayRuntimeOptions = {}) {
    this.envSource = options.envSource ?? process.env;
    this.envAllow = options.envAllow ?? [];
    const allow = [...DEFAULT_BASE_ENV_ALLOW, ...this.envAllow];
    this.baseEnv = buildBaseEnv(this.envSource, allow);
    this.stdioFactory = options.stdioFactory ?? createStdioTransportFactory();
    this.httpFactory = options.httpFactory ?? createHttpTransportFactory();
    this.fetch = options.fetch;
    this.secretResolver = options.secretResolver ?? this.defaultResolver();
  }

  /**
   * Fallback resolver: an allowlisted read of the injected env source. A name
   * outside the allowlist is refused even when present in the environment, so a
   * synced config can never exfiltrate an arbitrary host variable.
   */
  private defaultResolver(): GatewaySecretResolver {
    const allow = new Set([...DEFAULT_BASE_ENV_ALLOW, ...this.envAllow]);
    return {
      resolve: async (_projectId, names) => {
        const out: Record<string, string> = {};
        for (const name of names) {
          if (!allow.has(name)) continue;
          const v = this.envSource[name];
          if (v !== undefined) out[name] = v;
        }
        return out;
      },
    };
  }

  private key(projectId: string, serverId: string): string {
    return `${projectId}/${serverId}`;
  }

  /** True when a server is live (running/connected) and can accept a relay. */
  hasLiveServer(projectId: string, serverId: string): boolean {
    const rt = this.servers.get(this.key(projectId, serverId));
    if (!rt || rt.disabled || rt.missingEnv.length > 0) return false;
    if (rt.supervisor) return rt.supervisor.state.phase === "running";
    if (rt.connector) return rt.connector.state === "connected";
    return false;
  }

  /**
   * Reconcile desired projects against the running set. Enabled+trusted servers
   * with resolvable env start/connect; disabled/removed stop; changed specs
   * restart. Returns after all lifecycle transitions settle.
   */
  async reconcile(projects: readonly ProjectConfig[]): Promise<void> {
    const desired = new Map<string, { project: ProjectConfig; server: ServerConfig }>();
    for (const project of projects) {
      for (const server of project.servers) {
        desired.set(this.key(project.id, server.id), { project, server });
      }
    }

    // Stop servers no longer desired.
    for (const [k, rt] of [...this.servers]) {
      if (!desired.has(k)) {
        await this.stopServer(k, rt);
        this.servers.delete(k);
      }
    }

    // Start / restart / update desired servers.
    for (const [k, { project, server }] of desired) {
      await this.applyServer(k, project, server);
    }
  }

  /** Every `${NAME}` this server's launch spec references. */
  private referencedNames(server: ServerConfig): string[] {
    const refs = new Set<string>();
    const collect = (v: string): void => {
      for (const n of referencedEnvNames(v)) refs.add(n);
    };
    if (server.transport === "stdio") {
      for (const v of Object.values(server.env)) collect(v);
    } else {
      collect(server.url);
      for (const v of Object.values(server.headers)) collect(v);
    }
    return [...refs].sort();
  }

  private async applyServer(
    k: string,
    project: ProjectConfig,
    server: ServerConfig,
  ): Promise<void> {
    const nextHash = configHash({ ...project, servers: [server] });
    const existing = this.servers.get(k);
    const disabled = server.disabled || !project.enabled;

    // Resolve this server's references NOW. A name that does not resolve leaves
    // the server visible-inactive; we never start it with a blank secret.
    const names = this.referencedNames(server);
    let resolved: Readonly<Record<string, string>> = {};
    if (!disabled && names.length > 0) {
      try {
        resolved = await this.secretResolver.resolve(project.id, names);
      } catch {
        resolved = {};
      }
    }
    // `missingEnv` means "references that could not be resolved, holding this
    // server back". A DISABLED server is held back by nothing — it is off because
    // the operator turned it off, and no resolution was even attempted above. So
    // it reports no missing references: claiming otherwise made the UI tell people
    // to go and provide a value for a server they had deliberately switched off.
    const missingEnv = disabled ? [] : names.filter((n) => resolved[n] === undefined);

    if (existing) {
      const changed =
        existing.configHash !== nextHash ||
        existing.disabled !== disabled ||
        existing.missingEnv.length !== missingEnv.length ||
        existing.missingEnv.some((n, i) => n !== missingEnv[i]) ||
        // A provisioned secret must restart the server even when nothing else
        // changed, so saving a value activates it without an explicit restart.
        (existing.missingEnv.length === 0 && existing.resolvedHash !== hashResolved(resolved));
      if (!changed) return;
      await this.stopServer(k, existing);
      this.servers.delete(k);
    }

    const hub = new UpstreamHub();
    const rt: ServerRuntime = {
      projectId: project.id,
      serverId: server.id,
      transport: server.transport,
      configHash: nextHash,
      resolvedHash: hashResolved(resolved),
      hub,
      disabled,
      missingEnv,
    };
    this.servers.set(k, rt);

    if (disabled || missingEnv.length > 0) {
      // Visible-inactive: never started.
      return;
    }

    // An EnvResolver scoped to EXACTLY the values that resolved for this launch.
    const resolver = new EnvResolver({
      base: resolved,
      allow: Object.keys(resolved),
    });

    if (server.transport === "stdio") {
      await this.startStdio(rt, server, resolver);
    } else {
      await this.startHttp(rt, server, resolver);
    }
  }

  private async startStdio(
    rt: ServerRuntime,
    config: StdioServerConfig,
    resolver: EnvResolver,
  ): Promise<void> {
    const supervisor = new StdioSupervisor({
      config,
      resolver,
      baseEnv: this.baseEnv,
      factory: this.stdioFactory,
      onMessage: (m) => rt.hub.dispatch(m),
    });
    rt.supervisor = supervisor;
    rt.hub.setSender((m) => supervisor.send(m));
    try {
      await supervisor.start();
    } catch (err) {
      rt.lastError = redactError(err);
    }
  }

  private async startHttp(
    rt: ServerRuntime,
    config: HttpServerConfig,
    resolver: EnvResolver,
  ): Promise<void> {
    const connector = new HttpConnector({
      config,
      resolver,
      factory: this.httpFactory,
      ...(this.fetch !== undefined ? { fetch: this.fetch } : {}),
      onMessage: (m) => rt.hub.dispatch(m),
    });
    rt.connector = connector;
    rt.hub.setSender((m) => connector.send(m));
    try {
      await connector.connect();
    } catch (err) {
      rt.lastError = redactError(err);
    }
  }

  private async stopServer(k: string, rt: ServerRuntime): Promise<void> {
    for (const [sid, entry] of [...this.sessions]) {
      if (entry.serverKey === k) {
        await entry.relay.close().catch(() => {});
        this.sessions.delete(sid);
      }
    }
    try {
      if (rt.supervisor) await rt.supervisor.stop();
      if (rt.connector) await rt.connector.terminate();
    } finally {
      rt.hub.clear();
    }
  }

  /**
   * Open a relay session for a downstream client against a live server. The
   * `client` sink receives server->client and response messages for THIS
   * session only. Throws when the server is not live.
   */
  openSession(
    projectId: string,
    serverId: string,
    sessionId: string,
    client: ClientSink,
  ): RelaySession {
    const k = this.key(projectId, serverId);
    if (!this.hasLiveServer(projectId, serverId)) {
      throw new Error(`server ${k} is not live`);
    }
    const rt = this.servers.get(k)!;
    const relay = new RelaySession({ sessionId, upstream: rt.hub.view(), client });
    this.sessions.set(sessionId, { serverKey: k, relay });
    return relay;
  }

  /** Look up a live relay session. */
  session(sessionId: string): RelaySession | undefined {
    return this.sessions.get(sessionId)?.relay;
  }

  /** Close and forget one relay session. */
  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await entry.relay.close().catch(() => {});
    this.sessions.delete(sessionId);
  }

  /** Count open relay sessions for a server. */
  sessionCount(projectId: string, serverId: string): number {
    const k = this.key(projectId, serverId);
    let n = 0;
    for (const entry of this.sessions.values()) if (entry.serverKey === k) n += 1;
    return n;
  }

  /** Serializable status for all servers (never carries secrets). */
  status(): RuntimeServerStatus[] {
    const out: RuntimeServerStatus[] = [];
    for (const rt of this.servers.values()) {
      let phase = "idle";
      let restarts = 0;
      let consecutiveFailures = 0;
      if (rt.disabled) phase = "disabled";
      else if (rt.missingEnv.length > 0) phase = "env-error";
      else if (rt.supervisor) {
        const s = rt.supervisor.state;
        phase = s.phase;
        restarts = s.restarts;
        consecutiveFailures = s.consecutiveFailures;
      } else if (rt.connector) {
        phase = rt.connector.state;
      }
      out.push({
        projectId: rt.projectId,
        serverId: rt.serverId,
        transport: rt.transport,
        phase,
        restarts,
        consecutiveFailures,
        missingEnv: [...rt.missingEnv],
        sessions: this.sessionCount(rt.projectId, rt.serverId),
        ...(rt.lastError !== undefined ? { lastError: rt.lastError } : {}),
      });
    }
    return out;
  }

  /** True when no server or session remains live (post-shutdown assertion). */
  get isQuiescent(): boolean {
    return this.servers.size === 0 && this.sessions.size === 0;
  }

  /**
   * Bounded, already-redacted stderr / lifecycle lines for a stdio server. The
   * supervisor keeps a size-capped ring buffer; http connectors have no stderr,
   * so an empty list is returned for those. Never contains resolved secrets
   * (env values are never echoed to stderr by the supervisor).
   */
  serverLogs(projectId: string, serverId: string): string[] {
    const rt = this.servers.get(this.key(projectId, serverId));
    if (!rt || !rt.supervisor) return [];
    const buf = rt.supervisor.stderr;
    if (!buf) return [];
    return buf.split(/\r?\n/).filter((l) => l.length > 0).slice(-200);
  }

  /**
   * The transport factories and base child environment a real launch would use.
   *
   * Exposed so a one-shot connection test (see ServerProbe) runs against exactly
   * the same transports and allowlisted environment the server would get if it
   * were started for real — a test that used different plumbing would be able to
   * pass while the real launch fails.
   */
  get launchPlumbing(): {
    stdioFactory: StdioTransportFactory;
    httpFactory: HttpTransportFactory;
    baseEnv: Readonly<Record<string, string>>;
  } {
    return {
      stdioFactory: this.stdioFactory,
      httpFactory: this.httpFactory,
      baseEnv: this.baseEnv,
    };
  }

  /** Restart a single server (breaker reset + relaunch). */
  async restartServer(projectId: string, serverId: string): Promise<void> {
    const rt = this.servers.get(this.key(projectId, serverId));
    if (!rt) return;
    if (rt.supervisor) {
      await rt.supervisor.resetAndStart();
    } else if (rt.connector) {
      await rt.connector.terminate();
      await rt.connector.connect().catch((err) => {
        rt.lastError = redactError(err);
      });
    }
  }

  /** Shut down: close every session and every upstream. Idempotent. */
  async shutdown(): Promise<void> {
    for (const [, entry] of this.sessions) {
      await entry.relay.close().catch(() => {});
    }
    this.sessions.clear();
    for (const rt of this.servers.values()) {
      if (rt.supervisor) await rt.supervisor.stop().catch(() => {});
      if (rt.connector) await rt.connector.terminate().catch(() => {});
      rt.hub.clear();
    }
    this.servers.clear();
  }
}

/** Redact an error message to a bounded, secret-free string. */
function redactError(err: unknown): string {
  if (err instanceof EnvResolutionError) return "environment reference could not be resolved";
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 200);
}

/**
 * Fingerprint resolved reference values so a rotation can be detected without
 * retaining or exposing them. A random per-process salt means the digest is not
 * a guessable hash of the secret and is useless outside this process.
 */
const RESOLVED_SALT = randomBytes(32);
function hashResolved(resolved: Readonly<Record<string, string>>): string {
  const h = createHash("sha256").update(RESOLVED_SALT);
  for (const name of Object.keys(resolved).sort()) {
    h.update(name).update("\u0000").update(resolved[name] as string).update("\u0000");
  }
  return h.digest("hex");
}
