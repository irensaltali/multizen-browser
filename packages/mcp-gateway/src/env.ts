/**
 * Runtime resolution of `${NAME}` references against an allowlisted base env.
 *
 * Config stores only references; at launch/connect time we resolve them here.
 * Resolution is strict: an unresolved reference is an error, never a silent
 * empty string, so a misconfigured secret fails closed. Resolved values are
 * returned for immediate use and MUST NOT be written back into any config or
 * persisted anywhere.
 *
 * The allowlist is the set of environment variable names a project is permitted
 * to read. This prevents a config from exfiltrating arbitrary host env vars: a
 * reference to a name outside the allowlist is rejected even if present in the
 * base environment.
 */

import { pureEnvRefName, referencedEnvNames } from "./ids.js";

export class EnvResolutionError extends Error {
  override readonly name = "EnvResolutionError";
}

export interface EnvResolverOptions {
  /** The source of values, e.g. a filtered copy of process.env. */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** Names the config is permitted to reference. */
  readonly allow: readonly string[];
}

export class EnvResolver {
  private readonly base: Readonly<Record<string, string | undefined>>;
  private readonly allow: Set<string>;

  constructor(options: EnvResolverOptions) {
    this.base = options.base;
    this.allow = new Set(options.allow);
  }

  private value(name: string, path: string): string {
    if (!this.allow.has(name)) {
      throw new EnvResolutionError(`Reference to non-allowlisted variable ${name} at ${path}`);
    }
    const v = this.base[name];
    if (v === undefined) {
      throw new EnvResolutionError(`Unresolved environment variable ${name} at ${path}`);
    }
    return v;
  }

  /** Resolve a pure `${NAME}` reference to its value. */
  resolvePure(ref: string, path = "$"): string {
    const name = pureEnvRefName(ref);
    if (name === null) {
      throw new EnvResolutionError(`Not a pure \${NAME} reference at ${path}: ${ref}`);
    }
    return this.value(name, path);
  }

  /** Resolve every `${NAME}` occurrence inside a template string. */
  resolveTemplate(template: string, path = "$"): string {
    const names = referencedEnvNames(template);
    let out = template;
    for (const name of names) {
      const v = this.value(name, path);
      out = out.split(`\${${name}}`).join(v);
    }
    return out;
  }

  /** Resolve a map of child-visible name -> pure ref into concrete values. */
  resolveMap(map: Readonly<Record<string, string>>, path = "$"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, ref] of Object.entries(map)) {
      out[k] = this.resolvePure(ref, `${path}.${k}`);
    }
    return out;
  }
}

/**
 * Build a base env by copying only allowlisted names from `source`. The default
 * allowlist is intentionally minimal; callers extend it explicitly. This is the
 * "allowlisted base env" the stdio child inherits.
 */
export const DEFAULT_BASE_ENV_ALLOW: readonly string[] = ["PATH", "HOME", "TMPDIR", "LANG"];

export function buildBaseEnv(
  source: Readonly<Record<string, string | undefined>>,
  allow: readonly string[] = DEFAULT_BASE_ENV_ALLOW,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allow) {
    const v = source[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}
