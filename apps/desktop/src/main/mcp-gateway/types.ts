/**
 * Serializable view types for the MCP Gateway IPC surface.
 *
 * Every value crossing IPC to the renderer is defined here. The cardinal rule
 * mirrors the Cloud Sync controller: NEVER return an expanded env value, a
 * resolved header value, a resolved bearer token, or any private-key material.
 * Configs carry only `${NAME}` references (the safe, persisted form) and the
 * views below carry only reference NAMES, redacted markers, and booleans.
 */

/** Transport kinds an upstream server can use. */
export type GatewayTransportKind = "stdio" | "streamable-http";

/** A stdio upstream, as shown/edited in the UI. env values are `${NAME}` refs. */
export interface StdioServerView {
  readonly transport: "stdio";
  readonly id: string;
  readonly label?: string;
  readonly disabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  /** Child-visible name -> `${NAME}` reference. NEVER an expanded value. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** A streamable-http upstream. header values are `${NAME}` refs. */
export interface HttpServerView {
  readonly transport: "streamable-http";
  readonly id: string;
  readonly label?: string;
  readonly disabled: boolean;
  /** URL template; may contain `${NAME}` refs. */
  readonly url: string;
  /** Header name -> `${NAME}` reference. NEVER an expanded value. */
  readonly headers: Readonly<Record<string, string>>;
}

export type ServerView = StdioServerView | HttpServerView;

/** Per-project auth policy view. The token itself is never returned. */
export interface LocalAuthView {
  /** Default false — the project route requires no inbound bearer. */
  readonly enabled: boolean;
  /** `${NAME}` reference to the expected token (never the token value). */
  readonly tokenRef?: string;
  /** True when a device-local token secret is stored for this project. */
  readonly tokenPresent: boolean;
}

/** A full project as shown/edited in the UI. */
export interface ProjectView {
  readonly id: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly browserProfileId?: string;
  readonly localAuth: LocalAuthView;
  readonly servers: readonly ServerView[];
}

/** Runtime phase for one upstream server. */
export type ServerRuntimePhase =
  | "idle"
  | "starting"
  | "running"
  | "backoff"
  | "circuit-open"
  | "stopped"
  | "connecting"
  | "connected"
  | "terminated"
  | "disabled"
  | "env-error";

/** Runtime status for one server (never carries resolved secrets). */
export interface ServerRuntimeView {
  readonly projectId: string;
  readonly serverId: string;
  readonly transport: GatewayTransportKind;
  readonly phase: ServerRuntimePhase;
  readonly restarts: number;
  readonly consecutiveFailures: number;
  /** Redacted last error message (no secrets). */
  readonly lastError?: string;
  /** Env variable NAMES that are referenced but missing/forbidden. */
  readonly missingEnv: readonly string[];
  /** Open downstream sessions relayed to this server. */
  readonly sessions: number;
}

/** Runtime status for one project. */
export interface ProjectRuntimeView {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly bootstrapped: boolean;
  readonly servers: readonly ServerRuntimeView[];
}

/** The two route templates a project exposes (informational, copyable). */
export interface ProjectEndpointsView {
  readonly projectId: string;
  readonly baseUrl: string;
  /** `${base}/mcp/proxies/:project/:server` for each server. */
  readonly proxies: ReadonlyArray<{ serverId: string; url: string }>;
  /** `${base}/mcp/projects/:project/browser` (present only if bound). */
  readonly browser?: string;
  /** True when the project requires a bearer token. */
  readonly authRequired: boolean;
  /**
   * True when these URLs are actually being served. The gateway manages
   * projects and agent files even with the MCP HTTP transport disabled, in
   * which case the URLs are informational until it is enabled.
   */
  readonly served: boolean;
}

/** A bounded, redacted diagnostic log line for a server's stderr / lifecycle. */
export interface RuntimeLogView {
  readonly projectId: string;
  readonly serverId: string;
  readonly at: number;
  /** Already redacted: no env/header/token/command expansions. */
  readonly line: string;
}

/** A trusted/revoked device entry (public keys + roles only). */
export interface TrustDeviceView {
  readonly deviceId: string;
  readonly publicKeyHex: string;
  readonly role: "trusted" | "revoked";
  /** True when this row is THIS device. */
  readonly isSelf: boolean;
}

/** A durable conflict copy (keep-both) surfaced for explicit resolution. */
export interface ConflictView {
  readonly projectId: string;
  readonly attemptedRevision: number;
  readonly remoteRevision: number;
  readonly localSigner: string;
  readonly remoteSigner: string;
  readonly detectedAt: string;
  readonly reason: string;
}

/** A quarantined project (bad signature/trust/rollback) — never auto-starts. */
export interface QuarantineView {
  readonly projectId: string;
  readonly reason: string;
  readonly code: string;
  readonly detectedAt: string;
}

/** Whole-gateway sync status. */
export interface GatewaySyncStatusView {
  /** True when Cloud Sync is configured + ready for project sync. */
  readonly ready: boolean;
  readonly lastSyncAt: number | null;
  readonly lastError: string | null;
  readonly applied: number;
  readonly quarantined: number;
  readonly conflicts: number;
  readonly running: boolean;
}

/** Health/status snapshot for the whole gateway. */
export interface GatewayHealthView {
  readonly composed: boolean;
  readonly baseUrl: string | null;
  readonly projects: number;
  readonly runningServers: number;
  readonly openSessions: number;
  readonly sync: GatewaySyncStatusView;
}

/** Serializable op-result envelope (never throws across IPC). */
export type GatewayOpResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * Raw secret values typed directly into a server's env/header fields, keyed by
 * the SAME key as `env`/`headers`.
 *
 * This is the one place a value (rather than a `${NAME}` reference) crosses IPC.
 * The controller stores each one in OS secure storage under a derived name and
 * replaces the field with `${NAME}` before any config is built, so a value never
 * reaches the persisted — and synced — project config. A key present here wins
 * over the same key in `env`/`headers`.
 *
 * Omitting a key leaves whatever reference is already configured untouched, which
 * is how an edit avoids clobbering a stored value the operator did not retype.
 */
export type InlineSecretValues = Readonly<Record<string, string>>;

/** Input for creating/updating a stdio server (env values are `${NAME}` refs). */
export interface StdioServerInput {
  readonly transport: "stdio";
  readonly id: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** See {@link InlineSecretValues}. */
  readonly secretValues?: InlineSecretValues;
}

/** Input for creating/updating an http server (header values are `${NAME}` refs). */
export interface HttpServerInput {
  readonly transport: "streamable-http";
  readonly id: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** See {@link InlineSecretValues}. */
  readonly secretValues?: InlineSecretValues;
}

export type ServerInput = StdioServerInput | HttpServerInput;

/**
 * Outcome of a one-shot connection test against a server definition.
 *
 * `ok` means the MCP handshake completed — the command ran (or the URL answered),
 * authentication was accepted, and the server described itself. It says nothing
 * about whether the server is well-behaved beyond that.
 */
export interface ProbeResultView {
  readonly ok: boolean;
  /** Server-reported name/version from the initialize result, when it gave them. */
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly protocolVersion?: string;
  /** Tools the server advertises. Absent when it exposes no tools capability. */
  readonly toolCount?: number;
  /** First handful of tool names, for a recognisable confirmation. */
  readonly toolNames?: readonly string[];
  /** Milliseconds from launch to a completed handshake. */
  readonly durationMs: number;
  /** Redacted failure reason when `ok` is false. */
  readonly error?: string;
  /** What to try next, when the failure has an actionable cause. */
  readonly hint?: string;
  /** Reference NAMES that had no value, when that is why the test could not run. */
  readonly missingRefs?: readonly string[];
  /**
   * Bounded, redacted stderr from a stdio child. Almost always the only useful
   * diagnostic when a command fails to start, so it is surfaced rather than
   * swallowed.
   */
  readonly stderr?: readonly string[];
}

/** Input for creating a project. */
export interface CreateProjectInput {
  readonly id: string;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly browserProfileId?: string;
}

/** Input for patching a project's top-level fields. */
export interface UpdateProjectInput {
  readonly label?: string;
  readonly enabled?: boolean;
  /** null clears the binding; a string sets it; omitted leaves unchanged. */
  readonly browserProfileId?: string | null;
}


// ── Local workspace directories + agent configuration ─────────────────────
//
// A project may be associated with 0..N LOCAL directories. For each directory
// the operator selects any subset of supported coding agents; MultiZen then
// installs that project's enabled endpoints into each selected agent's
// workspace MCP configuration file.
//
// Absolute directory paths and installation state are DEVICE-LOCAL: they are
// persisted next to (never inside) the signed/synced ProjectConfig, so a synced
// project never carries another machine's filesystem layout.

/** The coding agents whose workspace MCP configuration MultiZen can manage. */
export type AgentKind = "claude-code" | "cursor" | "codex" | "kiro-cli";

/** Every supported agent, in stable display order. */
export const AGENT_KINDS: readonly AgentKind[] = [
  "claude-code",
  "cursor",
  "codex",
  "kiro-cli",
];

/** Human-readable agent labels for the UI. */
export const AGENT_LABELS: Readonly<Record<AgentKind, string>> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "kiro-cli": "Kiro CLI",
};

/** Installation state of one directory+agent pair. */
export type AgentInstallStatus =
  /** The desired entries are present and match what we last verified. */
  | "current"
  /** The project's desired endpoints changed since the last successful write. */
  | "out-of-date"
  /** The last attempt failed; `error` explains why and a retry is offered. */
  | "error";

/** Per-agent installation state for one directory (never carries secrets). */
export interface AgentInstallStateView {
  readonly agent: AgentKind;
  readonly status: AgentInstallStatus;
  /** Absolute path of the agent's workspace config file in this directory. */
  readonly configPath: string;
  /** Epoch ms of the last verified successful write, or null if never. */
  readonly lastInstalledAt: number | null;
  /** Redacted failure reason when `status` is "error". */
  readonly error?: string;
  /** Actionable recovery hint for a known agent-specific precondition. */
  readonly hint?: string;
}

/** One local directory associated with a project, plus its agent selection. */
export interface WorkspaceBindingView {
  readonly projectId: string;
  /** Canonical (realpath-resolved) absolute directory path. */
  readonly directory: string;
  /** Selected agents and their current installation state. */
  readonly agents: readonly AgentInstallStateView[];
}

/** Result of one reconcile pass over a project's directories. */
export interface ReconcileResultView {
  readonly projectId: string;
  /** True when every selected directory+agent pair is "current". */
  readonly allCurrent: boolean;
  readonly bindings: readonly WorkspaceBindingView[];
}

/** Source backing a `${NAME}` reference used by a server env/header value. */
export type SecretSource =
  /** Read from MultiZen's own process environment (device-local approval). */
  | "environment"
  /** Stored by MultiZen in OS secure storage; value never leaves the vault. */
  | "managed";

/**
 * Availability of one `${NAME}` reference. Carries the NAME, the source, and
 * presence booleans only — NEVER the value.
 */
export interface SecretRefStatusView {
  /** The referenced environment variable NAME (no `${}` wrapper). */
  readonly name: string;
  /** Where the value would be read from, or null when unresolvable. */
  readonly source: SecretSource | null;
  /** True when a value is currently resolvable from `source`. */
  readonly present: boolean;
  /** True when the operator approved reading this name from the environment. */
  readonly approved: boolean;
  /** True when a MultiZen-managed value is stored for this name. */
  readonly managed: boolean;
}

/** Input describing one directory and the agents selected for it. */
export interface WorkspaceBindingInput {
  /** Absolute directory path (canonicalized by the main process). */
  readonly directory: string;
  readonly agents: readonly AgentKind[];
}

/** A single guided-setup request that creates a project and installs it. */
export interface ProjectSetupInput {
  readonly id: string;
  readonly label?: string;
  /** Exclusive browser-profile binding, or null/undefined for none. */
  readonly browserProfileId?: string | null;
  /** Optional first upstream server. */
  readonly server?: ServerInput;
  /** Zero or more directories with their per-directory agent selection. */
  readonly directories?: readonly WorkspaceBindingInput[];
  /** Enable the project once the save + install reconcile succeeds. */
  readonly enableWhenReady?: boolean;
}

/** Outcome of a guided setup: the project plus its install reconcile result. */
export interface ProjectSetupResultView {
  readonly project: ProjectView;
  readonly reconcile: ReconcileResultView;
  /** True when the project was enabled (save + all installs succeeded). */
  readonly enabled: boolean;
}

/** A browser profile as offered in the exclusive binding selector. */
export interface BindableProfileView {
  readonly profileId: string;
  readonly name: string;
  /** Project currently holding this profile, when bound elsewhere. */
  readonly boundToProjectId?: string;
  /** False when the profile is bound to a DIFFERENT project. */
  readonly available: boolean;
}
