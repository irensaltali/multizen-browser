/**
 * Pure, testable construction of Kopia argument vectors.
 *
 * Design rules enforced here:
 *  - Only Kopia flags that are documented and verified are emitted. No made-up
 *    flags.
 *  - Secrets (repository password, AWS keys, session token) are NEVER placed on
 *    argv. Kopia reads them from the environment:
 *      * KOPIA_PASSWORD for the repository password.
 *      * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN for S3.
 *    Correspondingly we do NOT pass --password / --access-key /
 *    --secret-access-key / --session-token.
 *  - Every builder returns a plain string[] so tests can assert exact argv.
 *
 * Verified against the Kopia command-line reference
 * (https://kopia.io/docs/reference/command-line/flags/):
 *   - global:  --config-file
 *              --[no-]persist-credentials  (default true)
 *              --[no-]use-keyring          (default false)
 *              --[no-]auto-maintenance     (default true, [ADV])
 *   - repository connect filesystem  --path
 *   - repository connect s3          --bucket --endpoint --region --prefix
 *   - snapshot create <path> [--json] [--tags key:value ...]
 *   - snapshot list [source] [--json] [--all] [--tags key:value ...]
 *   - snapshot restore <id> <target>
 *
 * Credential-persistence hardening (applied on EVERY invocation):
 *   - `--no-persist-credentials` — Kopia defaults `persist-credentials` to
 *     true, which could write credentials into the config file. We never want
 *     that, so we always negate it.
 *
 * Kopia 0.23.1 does not expose the newer `use-keyring` or `auto-maintenance`
 * global flags, so this adapter intentionally does not emit them. The pinned
 * binary's CLI is exercised by the repository acceptance smoke test.
 */

/** Global options applied to (almost) every invocation. */
export interface GlobalKopiaOptions {
  /** Path to the Kopia config file (`--config-file`). */
  readonly configFile: string;
}

/**
 * Global argv emitted before every subcommand.
 *
 * Order is stable and deterministic so tests can assert an exact vector:
 *   --config-file <path>
 *   --no-persist-credentials
 *
 * Credential persistence is never configurable through this adapter.
 */
function globalArgs(opts: GlobalKopiaOptions): string[] {
  return ["--config-file", opts.configFile, "--no-persist-credentials"];
}

/** Local filesystem repository target. */
export interface FilesystemRepository {
  readonly kind: "filesystem";
  /** Directory that holds the Kopia repository (`--path`). */
  readonly path: string;
}

/**
 * S3-compatible repository target (AWS S3 or Cloudflare R2). Credentials are
 * intentionally absent from this shape — they flow through the environment.
 */
export interface S3Repository {
  readonly kind: "s3";
  /** Bucket name (`--bucket`). */
  readonly bucket: string;
  /**
   * Endpoint host (`--endpoint`), e.g. `s3.amazonaws.com` or
   * `<accountid>.r2.cloudflarestorage.com` for Cloudflare R2.
   */
  readonly endpoint?: string;
  /** Region (`--region`). R2 typically uses `auto`. */
  readonly region?: string;
  /** Object key prefix (`--prefix`). Trailing slash treated as a directory. */
  readonly prefix?: string;
}

export type RepositoryTarget = FilesystemRepository | S3Repository;

/**
 * Build argv for `kopia repository connect ...`.
 *
 * Never emits secret flags; AWS credentials + repo password come from env.
 */
export function buildConnectArgs(
  global: GlobalKopiaOptions,
  target: RepositoryTarget,
): string[] {
  const args = [...globalArgs(global), "repository", "connect"];

  if (target.kind === "filesystem") {
    args.push("filesystem", "--path", target.path);
    return args;
  }

  // s3
  args.push("s3", "--bucket", target.bucket);
  if (target.endpoint !== undefined) args.push("--endpoint", target.endpoint);
  if (target.region !== undefined) args.push("--region", target.region);
  if (target.prefix !== undefined) args.push("--prefix", target.prefix);
  return args;
}

/**
 * Build argv for `kopia repository create ...`. Same flag surface as connect
 * for the parts we use; secrets remain env-only.
 */
export function buildCreateArgs(
  global: GlobalKopiaOptions,
  target: RepositoryTarget,
): string[] {
  const args = [...globalArgs(global), "repository", "create"];

  if (target.kind === "filesystem") {
    args.push("filesystem", "--path", target.path);
    return args;
  }

  args.push("s3", "--bucket", target.bucket);
  if (target.endpoint !== undefined) args.push("--endpoint", target.endpoint);
  if (target.region !== undefined) args.push("--region", target.region);
  if (target.prefix !== undefined) args.push("--prefix", target.prefix);
  return args;
}

/**
 * Structured, validated snapshot tags.
 *
 * Kopia accepts arbitrary repeated `--tags key:value` pairs. We deliberately
 * expose only a fixed, known-safe set of correlation identifiers and never let
 * callers pass arbitrary secret material through here. Every value is validated
 * (see {@link validateTags}) so that:
 *   - no control characters (which could corrupt argv / terminal / logs) leak
 *     in, and
 *   - no ambiguous `key:value` separators or whitespace are smuggled in.
 */
export interface SnapshotTags {
  /** Stable profile identifier. */
  readonly profileId?: string;
  /** Device / client identifier producing the snapshot. */
  readonly deviceId?: string;
  /** Sync base revision this snapshot was taken from. */
  readonly baseRevision?: string;
  /** Correlates the snapshot with a higher-level sync operation. */
  readonly operationId?: string;
}

/** The tag keys we allow, in a stable emission order. */
export const ALLOWED_TAG_KEYS = [
  "profileId",
  "deviceId",
  "baseRevision",
  "operationId",
] as const;

export type AllowedTagKey = (typeof ALLOWED_TAG_KEYS)[number];

/**
 * Tag values must be a conservative allow-list: letters, digits, dash,
 * underscore, dot. 1..200 chars. This rejects:
 *   - control characters (`\n`, `\r`, `\0`, `\t`, escapes, etc.),
 *   - whitespace,
 *   - the `:` separator (which would let a value forge an extra key),
 *   - shell/argv-hostile punctuation.
 * That keeps tags usable as correlation ids while ensuring they can never smuggle
 * a secret-looking blob or control sequence onto argv or into logs.
 */
const TAG_VALUE_RE = /^[A-Za-z0-9._-]{1,200}$/;

export class TagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagValidationError";
  }
}

/**
 * Validate a {@link SnapshotTags} object, returning an ordered array of
 * `key:value` strings ready to follow repeated `--tags` flags. Unknown keys are
 * rejected; only the {@link ALLOWED_TAG_KEYS} are permitted. Undefined values
 * are skipped. Any present value that fails {@link TAG_VALUE_RE} throws.
 */
export function validateTags(tags: SnapshotTags): string[] {
  const raw = tags as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(ALLOWED_TAG_KEYS as readonly string[]).includes(key)) {
      throw new TagValidationError(`unknown tag key: ${JSON.stringify(key)}`);
    }
  }

  const pairs: string[] = [];
  for (const key of ALLOWED_TAG_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new TagValidationError(`tag ${key} must be a string (got ${typeof value})`);
    }
    if (!TAG_VALUE_RE.test(value)) {
      throw new TagValidationError(
        `tag ${key} must match ${TAG_VALUE_RE.source} (rejecting control chars, whitespace, ':' and secrets)`,
      );
    }
    pairs.push(`${key}:${value}`);
  }
  return pairs;
}

export interface SnapshotCreateOptions {
  /** Source directory to snapshot. Passed as a positional arg. */
  readonly source: string;
  /** Request machine-readable output (`--json`). Defaults to true. */
  readonly json?: boolean;
  /**
   * Optional validated correlation tags. Emitted as repeated `--tags key:value`
   * in {@link ALLOWED_TAG_KEYS} order. Values are validated; never secrets.
   */
  readonly tags?: SnapshotTags;
}

/** Build argv for `kopia snapshot create <source> [--json] [--tags k:v ...]`. */
export function buildSnapshotCreateArgs(
  global: GlobalKopiaOptions,
  opts: SnapshotCreateOptions,
): string[] {
  const args = [...globalArgs(global), "snapshot", "create", opts.source];
  if (opts.json !== false) args.push("--json");
  if (opts.tags !== undefined) {
    for (const pair of validateTags(opts.tags)) {
      args.push("--tags", pair);
    }
  }
  return args;
}

export interface SnapshotListOptions {
  /** Optional source filter (positional). */
  readonly source?: string;
  /** Request JSON output (`--json`). Defaults to true. */
  readonly json?: boolean;
  /** Include all users/hosts (`--all`). Defaults to false. */
  readonly all?: boolean;
  /**
   * Optional validated tag filters. Emitted as repeated `--tags key:value` in
   * {@link ALLOWED_TAG_KEYS} order. Values are validated; never secrets.
   */
  readonly tags?: SnapshotTags;
}

/** Build argv for `kopia snapshot list [source] [--all] [--json] [--tags k:v ...]`. */
export function buildSnapshotListArgs(
  global: GlobalKopiaOptions,
  opts: SnapshotListOptions = {},
): string[] {
  const args = [...globalArgs(global), "snapshot", "list"];
  if (opts.source !== undefined) args.push(opts.source);
  if (opts.all === true) args.push("--all");
  if (opts.json !== false) args.push("--json");
  if (opts.tags !== undefined) {
    for (const pair of validateTags(opts.tags)) {
      args.push("--tags", pair);
    }
  }
  return args;
}

export interface SnapshotRestoreOptions {
  /** Snapshot ID or object ID to restore (positional). */
  readonly id: string;
  /** Target directory to restore into (positional). */
  readonly target: string;
}

/** Build argv for `kopia snapshot restore <id> <target>`. */
export function buildSnapshotRestoreArgs(
  global: GlobalKopiaOptions,
  opts: SnapshotRestoreOptions,
): string[] {
  return [...globalArgs(global), "snapshot", "restore", opts.id, opts.target];
}
