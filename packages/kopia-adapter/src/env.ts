/**
 * Minimal child-process environment construction.
 *
 * Secrets are injected ONLY through the child environment, never through argv.
 * The child receives a deliberately small, explicit env rather than inheriting
 * the parent's (which could carry unrelated secrets or influence Kopia in
 * surprising ways).
 */

/** Names of environment variables that carry secret values. */
export const SECRET_ENV_KEYS = [
  "KOPIA_PASSWORD",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

/** Secret material supplied by the caller for a Kopia invocation. */
export interface KopiaSecrets {
  /** Repository password. Consumed by Kopia via KOPIA_PASSWORD. Required. */
  readonly kopiaPassword: string;
  /** S3/R2 access key id. Consumed via AWS_ACCESS_KEY_ID. */
  readonly awsAccessKeyId?: string;
  /** S3/R2 secret access key. Consumed via AWS_SECRET_ACCESS_KEY. */
  readonly awsSecretAccessKey?: string;
  /** Optional STS session token. Consumed via AWS_SESSION_TOKEN. */
  readonly awsSessionToken?: string;
}

/**
 * A base set of harmless environment variables to carry into the child so that
 * Kopia can locate temp dirs, a home directory, and behave in a stable locale.
 * Values are only forwarded if present in the parent env; nothing is invented.
 */
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "windir",
  "LANG",
  "LC_ALL",
] as const;

export interface BuildEnvOptions {
  readonly secrets: KopiaSecrets;
  /**
   * The parent environment to selectively pass through. Defaults to
   * `process.env`. Injectable for testing.
   */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Extra non-secret variables to add to the child env (e.g. a custom cache
   * dir). These are merged last but MUST NOT be secret keys.
   */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * Build the complete, minimal environment for a Kopia child process.
 *
 * Guarantees:
 *  - Only whitelisted passthrough keys + secret keys + explicit extras appear.
 *  - Secrets appear ONLY here (env), and only when a value is provided.
 *  - Disables Kopia's GitHub update check to avoid unexpected network egress.
 */
export function buildChildEnv(options: BuildEnvOptions): Record<string, string> {
  const parentEnv = options.parentEnv ?? (process.env as Record<string, string | undefined>);
  const env: Record<string, string> = {};

  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  // Secrets — env only.
  env.KOPIA_PASSWORD = options.secrets.kopiaPassword;
  if (options.secrets.awsAccessKeyId !== undefined) {
    env.AWS_ACCESS_KEY_ID = options.secrets.awsAccessKeyId;
  }
  if (options.secrets.awsSecretAccessKey !== undefined) {
    env.AWS_SECRET_ACCESS_KEY = options.secrets.awsSecretAccessKey;
  }
  if (options.secrets.awsSessionToken !== undefined) {
    env.AWS_SESSION_TOKEN = options.secrets.awsSessionToken;
  }

  // Reduce surprising network egress from the child.
  env.KOPIA_CHECK_FOR_UPDATES = "false";

  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if ((SECRET_ENV_KEYS as readonly string[]).includes(key)) {
        throw new Error(`extra env must not contain secret key: ${key}`);
      }
      env[key] = value;
    }
  }

  return env;
}

/**
 * Collect the non-empty secret VALUES from a {@link KopiaSecrets} for use as
 * redaction inputs. This lets the runner scrub any secret that leaks into
 * Kopia's stdout/stderr.
 */
export function secretValues(secrets: KopiaSecrets): string[] {
  const values = [
    secrets.kopiaPassword,
    secrets.awsAccessKeyId,
    secrets.awsSecretAccessKey,
    secrets.awsSessionToken,
  ];
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}
