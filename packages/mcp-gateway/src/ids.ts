/**
 * Safe identifiers and environment-reference values.
 *
 * Project and server IDs are embedded into filesystem paths and HTTP route
 * segments, so they are restricted to a conservative slug grammar with no
 * separators, dots, or path traversal potential. IDs are also used as JSON keys
 * and signing subjects, so the same grammar keeps them stable.
 *
 * Configuration values that reference secrets must NEVER contain the expanded
 * secret. They are stored only as `${NAME}` references and resolved at runtime
 * against an allowlisted environment. This module owns the reference grammar
 * and parser; resolution lives in the upstream runtime.
 */

const ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type ServerId = string & { readonly __brand: "ServerId" };

export class InvalidIdError extends Error {
  override readonly name = "InvalidIdError";
}

/** True when `value` is a safe slug: 1–64 chars, [a-z0-9_-], no leading/trailing separator. */
export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function assertProjectId(value: unknown): ProjectId {
  if (!isSafeId(value)) {
    throw new InvalidIdError(`Invalid project id: ${JSON.stringify(value)}`);
  }
  return value as ProjectId;
}

export function assertServerId(value: unknown): ServerId {
  if (!isSafeId(value)) {
    throw new InvalidIdError(`Invalid server id: ${JSON.stringify(value)}`);
  }
  return value as ServerId;
}

/**
 * Environment variable name grammar for `${NAME}` references. POSIX-ish: a
 * letter or underscore followed by letters, digits, or underscores.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_REF_GLOBAL_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function isEnvName(name: unknown): name is string {
  return typeof name === "string" && ENV_NAME_RE.test(name);
}

/**
 * A value that is exactly a single reference, e.g. `${API_TOKEN}`.
 * These are the only accepted form for secret-bearing fields (headers, env).
 */
export function isPureEnvRef(value: unknown): value is string {
  return typeof value === "string" && ENV_REF_RE.test(value);
}

/** Extract the NAME from a pure `${NAME}` reference, or null if not pure. */
export function pureEnvRefName(value: string): string | null {
  const m = ENV_REF_RE.exec(value);
  return m ? (m[1] as string) : null;
}

/** All env names referenced anywhere inside a string (for URLs etc.). */
export function referencedEnvNames(value: string): string[] {
  const names = new Set<string>();
  for (const m of value.matchAll(ENV_REF_GLOBAL_RE)) {
    names.add(m[1] as string);
  }
  return [...names];
}

/** True when the string contains no `${...}` sequences at all. */
export function hasNoEnvRef(value: string): boolean {
  return !value.includes("${");
}
