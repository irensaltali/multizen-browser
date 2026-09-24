/**
 * Versioned ProjectConfig schema and validation.
 *
 * A ProjectConfig is the *desired* configuration for one project: a set of
 * upstream MCP servers plus project-level flags. It is the durable, signable
 * unit of the gateway. Runtime state (which servers are actually running,
 * backoff counters, sessions) lives elsewhere and is never mixed in here.
 *
 * Design rules enforced by the parser:
 *  - Strict shape: unknown keys are rejected so a tampered/forward file cannot
 *    smuggle fields past validation.
 *  - Versioned: `configVersion` gates parsing; older versions are migrated,
 *    unknown/newer versions are rejected.
 *  - Env-reference-only secrets: header values and env values must be pure
 *    `${NAME}` references. Expanded secrets are never accepted or persisted.
 *  - `enabled` (project) and `disabled` (server) are first-class *desired*
 *    state and always round-trip through the store.
 */

import {
  assertProjectId,
  assertServerId,
  hasNoEnvRef,
  isPureEnvRef,
  isSafeId,
  type ProjectId,
  type ServerId,
} from "./ids.js";

export const CONFIG_VERSION = 1 as const;

export class ConfigValidationError extends Error {
  override readonly name = "ConfigValidationError";
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
  }
}

export interface LocalAuthConfig {
  /** When false (default) the project route requires no inbound bearer token. */
  readonly enabled: boolean;
  /**
   * Pure `${NAME}` reference to the expected bearer token, resolved at runtime.
   * Only meaningful when `enabled` is true. Never an inline secret.
   */
  readonly tokenRef?: string;
}

export interface StdioServerConfig {
  readonly transport: "stdio";
  /** Desired server id, unique within the project. */
  readonly id: ServerId;
  /** Human label; optional. */
  readonly label?: string;
  /** When true the server is never started (desired-disabled). Defaults false. */
  readonly disabled: boolean;
  /** Executable path/name. Shell-free: never passed through a shell. */
  readonly command: string;
  /** Literal argument vector. No shell expansion. */
  readonly args: readonly string[];
  /**
   * Environment references to expose to the child, keyed by the child-visible
   * name. Each value must be a pure `${NAME}` reference resolved at runtime
   * against the allowlisted base env.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Optional working directory; must contain no env refs. */
  readonly cwd?: string;
}

export interface HttpServerConfig {
  readonly transport: "streamable-http";
  readonly id: ServerId;
  readonly label?: string;
  readonly disabled: boolean;
  /**
   * Upstream URL. May contain `${NAME}` references (e.g. host/token in path)
   * resolved at runtime. Must resolve to an http(s) URL.
   */
  readonly url: string;
  /**
   * Upstream request headers. Values must be pure `${NAME}` references so no
   * secret is persisted. Header names are validated as HTTP tokens.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface ProjectConfig {
  readonly configVersion: typeof CONFIG_VERSION;
  readonly id: ProjectId;
  readonly label?: string;
  /** Project-level desired enable flag. Disabled projects start nothing. */
  readonly enabled: boolean;
  /** Optional association with a browser profile for the browser route. */
  readonly browserProfileId?: string;
  readonly localAuth: LocalAuthConfig;
  readonly servers: readonly ServerConfig[];
}

const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConfigValidationError(`Unknown key "${key}"`, path);
    }
  }
}

function parseEnvRefMap(
  raw: unknown,
  path: string,
): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError("Expected object", path);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || !isPureEnvRef(v)) {
      throw new ConfigValidationError(
        `Value for "${k}" must be a pure \${NAME} reference`,
        `${path}.${k}`,
      );
    }
    out[k] = v;
  }
  return out;
}

function parseHeaderMap(raw: unknown, path: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError("Expected object", path);
  }
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!HTTP_TOKEN_RE.test(name)) {
      throw new ConfigValidationError(`Invalid header name "${name}"`, path);
    }
    // NOTE: Authorization as an *upstream* header is allowed here (it is a
    // separate upstream credential expressed as a ${NAME} reference).
    // Forwarding the *inbound* Authorization is prohibited in the router.
    if (typeof v !== "string" || !isPureEnvRef(v)) {
      throw new ConfigValidationError(
        `Header "${name}" must be a pure \${NAME} reference`,
        `${path}.${name}`,
      );
    }
    out[name] = v;
  }
  return out;
}

function parseStringArray(raw: unknown, path: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError("Expected array", path);
  }
  return raw.map((item, i) => {
    if (typeof item !== "string") {
      throw new ConfigValidationError("Expected string", `${path}[${i}]`);
    }
    return item;
  });
}

function parseServer(raw: unknown, path: string): ServerConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError("Expected object", path);
  }
  const transport = raw["transport"];
  if (!isSafeId(raw["id"])) {
    throw new ConfigValidationError("Invalid or missing server id", `${path}.id`);
  }
  const id = assertServerId(raw["id"]);
  const label = raw["label"];
  if (label !== undefined && typeof label !== "string") {
    throw new ConfigValidationError("label must be a string", `${path}.label`);
  }
  const disabled = raw["disabled"] === undefined ? false : raw["disabled"];
  if (typeof disabled !== "boolean") {
    throw new ConfigValidationError("disabled must be a boolean", `${path}.disabled`);
  }

  if (transport === "stdio") {
    requireKeys(raw, ["transport", "id", "label", "disabled", "command", "args", "env", "cwd"], path);
    if (typeof raw["command"] !== "string" || raw["command"].length === 0) {
      throw new ConfigValidationError("command must be a non-empty string", `${path}.command`);
    }
    const cwd = raw["cwd"];
    if (cwd !== undefined) {
      if (typeof cwd !== "string") {
        throw new ConfigValidationError("cwd must be a string", `${path}.cwd`);
      }
      if (!hasNoEnvRef(cwd)) {
        throw new ConfigValidationError("cwd must not contain env references", `${path}.cwd`);
      }
    }
    const server: StdioServerConfig = {
      transport: "stdio",
      id,
      ...(label !== undefined ? { label } : {}),
      disabled,
      command: raw["command"],
      args: parseStringArray(raw["args"], `${path}.args`),
      env: parseEnvRefMap(raw["env"], `${path}.env`),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    return server;
  }

  if (transport === "streamable-http") {
    requireKeys(raw, ["transport", "id", "label", "disabled", "url", "headers"], path);
    if (typeof raw["url"] !== "string" || raw["url"].length === 0) {
      throw new ConfigValidationError("url must be a non-empty string", `${path}.url`);
    }
    const server: HttpServerConfig = {
      transport: "streamable-http",
      id,
      ...(label !== undefined ? { label } : {}),
      disabled,
      url: raw["url"],
      headers: parseHeaderMap(raw["headers"], `${path}.headers`),
    };
    return server;
  }

  throw new ConfigValidationError(
    `Unknown transport ${JSON.stringify(transport)}`,
    `${path}.transport`,
  );
}

function parseLocalAuth(raw: unknown, path: string): LocalAuthConfig {
  if (raw === undefined) return { enabled: false };
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError("Expected object", path);
  }
  requireKeys(raw, ["enabled", "tokenRef"], path);
  const enabled = raw["enabled"] === undefined ? false : raw["enabled"];
  if (typeof enabled !== "boolean") {
    throw new ConfigValidationError("enabled must be a boolean", `${path}.enabled`);
  }
  const tokenRef = raw["tokenRef"];
  if (tokenRef !== undefined) {
    if (typeof tokenRef !== "string" || !isPureEnvRef(tokenRef)) {
      throw new ConfigValidationError(
        "tokenRef must be a pure ${NAME} reference",
        `${path}.tokenRef`,
      );
    }
  }
  return {
    enabled,
    ...(tokenRef !== undefined ? { tokenRef } : {}),
  };
}

/**
 * Parse and validate a raw JSON value into a ProjectConfig. Throws
 * ConfigValidationError on any deviation from the strict schema. Migrations for
 * older versions are applied before validation.
 */
export function parseProjectConfig(raw: unknown): ProjectConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError("Expected object", "$");
  }
  const migrated = migrate(raw);

  requireKeys(
    migrated,
    ["configVersion", "id", "label", "enabled", "browserProfileId", "localAuth", "servers"],
    "$",
  );

  if (migrated["configVersion"] !== CONFIG_VERSION) {
    throw new ConfigValidationError(
      `Unsupported configVersion ${JSON.stringify(migrated["configVersion"])}`,
      "$.configVersion",
    );
  }
  if (!isSafeId(migrated["id"])) {
    throw new ConfigValidationError("Invalid or missing project id", "$.id");
  }
  const id = assertProjectId(migrated["id"]);

  const label = migrated["label"];
  if (label !== undefined && typeof label !== "string") {
    throw new ConfigValidationError("label must be a string", "$.label");
  }

  const enabled = migrated["enabled"] === undefined ? true : migrated["enabled"];
  if (typeof enabled !== "boolean") {
    throw new ConfigValidationError("enabled must be a boolean", "$.enabled");
  }

  const browserProfileId = migrated["browserProfileId"];
  if (browserProfileId !== undefined) {
    if (typeof browserProfileId !== "string" || browserProfileId.length === 0) {
      throw new ConfigValidationError(
        "browserProfileId must be a non-empty string",
        "$.browserProfileId",
      );
    }
  }

  const servers = migrated["servers"];
  if (servers !== undefined && !Array.isArray(servers)) {
    throw new ConfigValidationError("servers must be an array", "$.servers");
  }
  const parsedServers = (servers ?? []).map((s: unknown, i: number) =>
    parseServer(s, `$.servers[${i}]`),
  );
  const seen = new Set<string>();
  for (const s of parsedServers) {
    if (seen.has(s.id)) {
      throw new ConfigValidationError(`Duplicate server id "${s.id}"`, "$.servers");
    }
    seen.add(s.id);
  }

  return {
    configVersion: CONFIG_VERSION,
    id,
    ...(label !== undefined ? { label } : {}),
    enabled,
    ...(browserProfileId !== undefined ? { browserProfileId } : {}),
    localAuth: parseLocalAuth(migrated["localAuth"], "$.localAuth"),
    servers: parsedServers,
  };
}

/**
 * Apply forward migrations to a raw config object. Version 0 (or missing
 * version) is treated as a pre-versioned draft and upgraded to v1 by stamping
 * the version; unknown *newer* versions are left as-is and rejected by the
 * caller. Migrations must be pure and never inject secrets.
 */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const version = raw["configVersion"];
  if (version === undefined || version === 0) {
    return { ...raw, configVersion: CONFIG_VERSION };
  }
  return raw;
}

/**
 * Serialize a ProjectConfig to a plain JSON value suitable for canonicalization
 * and persistence. This is the only representation written to disk; it contains
 * no runtime state and no expanded secrets (guaranteed by parse-time checks).
 */
export function projectConfigToJson(config: ProjectConfig): Record<string, unknown> {
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
      ...(config.localAuth.tokenRef !== undefined
        ? { tokenRef: config.localAuth.tokenRef }
        : {}),
    },
    servers: config.servers.map((s) =>
      s.transport === "stdio"
        ? {
            transport: s.transport,
            id: s.id,
            ...(s.label !== undefined ? { label: s.label } : {}),
            disabled: s.disabled,
            command: s.command,
            args: [...s.args],
            env: { ...s.env },
            ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
          }
        : {
            transport: s.transport,
            id: s.id,
            ...(s.label !== undefined ? { label: s.label } : {}),
            disabled: s.disabled,
            url: s.url,
            headers: { ...s.headers },
          },
    ),
  };
}
