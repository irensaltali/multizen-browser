/**
 * High-level Kopia adapter.
 *
 * Wires together the injectable process runner, minimal-env builder, command
 * construction, quiescence guard, and JSON parsing into snapshot / list /
 * restore operations. All secrets flow through the environment only; the
 * process runner redacts any secret values that appear in captured output.
 */

import {
  buildConnectArgs,
  buildCreateArgs,
  buildMaintenanceRunArgs,
  buildSnapshotCreateArgs,
  buildSnapshotDeleteArgs,
  buildSnapshotListArgs,
  buildSnapshotRestoreArgs,
  validateSnapshotId,
  type GlobalKopiaOptions,
  type MaintenanceRunOptions,
  type RepositoryTarget,
  type SnapshotListOptions,
  type SnapshotTags,
} from "./commands.js";
import { buildChildEnv, secretValues, type KopiaSecrets } from "./env.js";
import { isRepositoryNotInitialized } from "./ensure-repository.js";
import { parseJson, parseJsonArray } from "./json.js";
import { validateId } from "./manifest.js";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "./process-runner.js";
import { assertQuiescent, type QuiescenceGuard } from "./quiescence.js";

export interface KopiaAdapterOptions {
  /** Absolute path to the kopia binary. Never passed through a shell. */
  readonly bin: string;
  /** Global CLI options (config file path). */
  readonly global: GlobalKopiaOptions;
  /** Secret material (env-only). */
  readonly secrets: KopiaSecrets;
  /** Injectable process runner. Defaults to the real spawn-based runner. */
  readonly runner?: ProcessRunner;
  /** Quiescence guard consulted before snapshot/restore. */
  readonly guard: QuiescenceGuard;
  /** Default per-command timeout in milliseconds. */
  readonly defaultTimeoutMs?: number;
  /** Parent env for passthrough vars. Defaults to process.env. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

export class KopiaCommandError extends Error {
  constructor(
    message: string,
    readonly result: ProcessResult,
  ) {
    super(message);
    this.name = "KopiaCommandError";
  }
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Outcome of {@link KopiaAdapter.ensureRepository}. `created` is true only when
 * this call actually initialized a brand-new repository (connect reported the
 * pinned "not initialized in the provided storage" condition and a subsequent
 * create succeeded); false when an existing repository was connected.
 */
export interface EnsureRepositoryResult {
  readonly created: boolean;
}

/** The `tag:` prefix Kopia adds to every user tag key in `snapshot list --json`. */
const KOPIA_TAG_PREFIX = "tag:";

/**
 * A minimally-parsed, validated snapshot manifest record as returned by
 * {@link KopiaAdapter.listProfileSnapshots}. Only the fields this adapter needs
 * are surfaced; the raw record is preserved for callers that want more.
 */
export interface ProfileSnapshot {
  /** The validated Kopia snapshot manifest id (safe to place on argv). */
  readonly id: string;
  /** The profileId tag value that was confirmed on this record. */
  readonly profileId: string;
  /** The raw JSON record as parsed from Kopia's output. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Outcome of {@link KopiaAdapter.deleteProfileSnapshots}. Idempotent: when a
 * profile has no snapshots, `deletedIds` is empty and `deleted` is 0 — this is
 * a success, not an error (nothing to delete === already absent).
 */
export interface DeleteProfileSnapshotsResult {
  /** The profile whose snapshots were targeted. */
  readonly profileId: string;
  /** The exact snapshot manifest ids that were deleted (validated). */
  readonly deletedIds: readonly string[];
  /** Convenience count === deletedIds.length. */
  readonly deleted: number;
}

export class KopiaAdapter {
  private readonly runner: ProcessRunner;

  constructor(private readonly opts: KopiaAdapterOptions) {
    this.runner = opts.runner ?? new NodeProcessRunner();
  }

  /** Execute an arbitrary Kopia argv, returning the (redacted) result. */
  private async exec(args: readonly string[], run: RunOptions = {}): Promise<ProcessResult> {
    const env = buildChildEnv({
      secrets: this.opts.secrets,
      parentEnv: this.opts.parentEnv,
    });
    const result = await this.runner.run({
      bin: this.opts.bin,
      args,
      env,
      timeoutMs: run.timeoutMs ?? this.opts.defaultTimeoutMs,
      signal: run.signal,
      redact: secretValues(this.opts.secrets),
    });
    return result;
  }

  private ensureOk(what: string, result: ProcessResult): ProcessResult {
    if (result.timedOut) {
      throw new KopiaCommandError(`${what} timed out`, result);
    }
    if (result.aborted) {
      throw new KopiaCommandError(`${what} was aborted`, result);
    }
    if (result.code !== 0) {
      throw new KopiaCommandError(
        `${what} failed with exit code ${result.code}: ${result.stderr.trim()}`,
        result,
      );
    }
    return result;
  }

  /** `kopia repository connect ...` */
  async connect(target: RepositoryTarget, run?: RunOptions): Promise<void> {
    const args = buildConnectArgs(this.opts.global, target);
    this.ensureOk("repository connect", await this.exec(args, run));
  }

  /** `kopia repository create ...` */
  async createRepository(target: RepositoryTarget, run?: RunOptions): Promise<void> {
    const args = buildCreateArgs(this.opts.global, target);
    this.ensureOk("repository create", await this.exec(args, run));
  }

  /**
   * Idempotently ensure the encrypted repository exists in the provided
   * storage, then leave this device connected to it.
   *
   * Behavior:
   *   1. Attempt `repository connect`. If it succeeds, an existing repository
   *      was found → returns `{ created: false }` (nothing was initialized).
   *   2. If connect fails with EXACTLY the pinned 0.23.1 "repository not
   *      initialized in the provided storage" condition (see
   *      {@link isRepositoryNotInitialized}), create the repository, then
   *      return `{ created: true }`. The device is left connected by the
   *      successful create.
   *   3. If create fails because a concurrent device already created the
   *      repository between our connect and create (a create race), ONE safe
   *      reconnect is attempted; if that reconnect succeeds the repository now
   *      exists → returns `{ created: false }`.
   *   4. Any other error (auth, network, corruption, an unrelated repository
   *      error) propagates UNCHANGED — this method never masks a real failure
   *      as a missing-repository condition and never creates over one.
   *
   * Secrets never touch argv (env-only) and captured output is redacted by the
   * runner, so a propagated {@link KopiaCommandError} carries no secret values.
   */
  async ensureRepository(
    target: RepositoryTarget,
    run?: RunOptions,
  ): Promise<EnsureRepositoryResult> {
    try {
      await this.connect(target, run);
      return { created: false };
    } catch (err) {
      if (!(err instanceof KopiaCommandError) || !this.isMissingRepository(err)) {
        // Not the specific missing-repository condition → propagate unchanged.
        throw err;
      }
      // The repository does not yet exist in the provided storage → create it.
      try {
        await this.createRepository(target, run);
        return { created: true };
      } catch (createErr) {
        // Create race / already-created between our connect and create: one
        // safe reconnect can resolve it. Only retry when create failed because
        // a repository now exists ("already initialized" style condition);
        // otherwise propagate the create error unchanged.
        if (
          createErr instanceof KopiaCommandError &&
          this.isRepositoryAlreadyExists(createErr)
        ) {
          await this.connect(target, run);
          return { created: false };
        }
        throw createErr;
      }
    }
  }

  /** True when a connect error is the pinned missing-repository condition. */
  private isMissingRepository(err: KopiaCommandError): boolean {
    return (
      isRepositoryNotInitialized(err.message) ||
      isRepositoryNotInitialized(err.result.stderr)
    );
  }

  /**
   * True when a create error indicates the repository already exists (a
   * create race). Kopia 0.23.1 reports an "already initialized" style message
   * when a repository is present in the provided storage.
   */
  private isRepositoryAlreadyExists(err: KopiaCommandError): boolean {
    const text = `${err.message}\n${err.result.stderr}`;
    return /already\s+initialized|already\s+exists|found\s+existing\s+data/i.test(text);
  }

  /**
   * `kopia snapshot create <source>` — refuses to run unless the resource is
   * quiescent. Returns the parsed JSON manifest emitted by Kopia.
   *
   * `tags` is optional (kept optional for backward compatibility with existing
   * desktop call sites). When provided, only the validated correlation tags in
   * {@link SnapshotTags} are emitted as repeated `--tags key:value`; invalid or
   * secret-looking values are rejected before any process is spawned.
   */
  async snapshot(
    resourceId: string,
    source: string,
    tags?: SnapshotTags,
    run?: RunOptions,
  ): Promise<unknown> {
    await assertQuiescent(this.opts.guard, resourceId);
    const args = buildSnapshotCreateArgs(this.opts.global, { source, json: true, tags });
    const result = this.ensureOk("snapshot create", await this.exec(args, run));
    return parseJson(result.stdout);
  }

  /** `kopia snapshot list --json` — returns parsed array of snapshot records. */
  async list(opts: SnapshotListOptions = {}, run?: RunOptions): Promise<unknown[]> {
    const args = buildSnapshotListArgs(this.opts.global, { ...opts, json: true });
    const result = this.ensureOk("snapshot list", await this.exec(args, run));
    return parseJsonArray(result.stdout);
  }

  /**
   * `kopia snapshot restore <id> <target>` — refuses to run unless the resource
   * is quiescent. The caller is responsible for the atomic swap of the restored
   * data into place (see swap.ts).
   */
  async restore(
    resourceId: string,
    id: string,
    target: string,
    run?: RunOptions,
  ): Promise<void> {
    await assertQuiescent(this.opts.guard, resourceId);
    const args = buildSnapshotRestoreArgs(this.opts.global, { id, target });
    this.ensureOk("snapshot restore", await this.exec(args, run));
  }

  /**
   * List the snapshot manifests that belong to EXACTLY one profile.
   *
   * The profileId is validated (same conservative id shape used everywhere in
   * this package) before it is ever placed on argv as a `--tags profileId:<id>`
   * filter. Kopia performs server-side tag filtering, but we DO NOT trust that
   * alone: every returned record is independently re-checked to carry the exact
   * `tag:profileId` value we asked for, and its `id` is re-validated as a
   * well-formed manifest id. Any record that is malformed, missing the tag, or
   * carries a different profileId is dropped — so no other profile's snapshot
   * can ever be selected even if Kopia (or a tampered result) returned extras.
   *
   * Malformed list output (non-array, non-object entries, missing/invalid id)
   * is defended against: bad entries are skipped, never coerced into a delete.
   */
  async listProfileSnapshots(profileId: string, run?: RunOptions): Promise<ProfileSnapshot[]> {
    const validProfileId = validateId(profileId, "profileId");
    // Tag filter is applied server-side; `--all` so we never miss a snapshot
    // that was created under a different host/user for the same profile.
    const args = buildSnapshotListArgs(this.opts.global, {
      json: true,
      all: true,
      tags: { profileId: validProfileId },
    });
    const result = this.ensureOk("snapshot list", await this.exec(args, run));
    const records = parseJsonArray(result.stdout);
    return this.selectExactProfileSnapshots(records, validProfileId);
  }

  /**
   * Client-side, defense-in-depth filter: from a raw parsed list, keep only the
   * records that (a) are objects, (b) carry a valid manifest `id`, and (c) carry
   * EXACTLY `tag:<validProfileId>` in their `tags` map. Everything else is
   * dropped. This guarantees the returned ids are a subset of the requested
   * profile's snapshots and are all safe to place on a delete argv.
   */
  private selectExactProfileSnapshots(
    records: readonly unknown[],
    validProfileId: string,
  ): ProfileSnapshot[] {
    const out: ProfileSnapshot[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
      const raw = record as Record<string, unknown>;

      // Validate the id shape; skip malformed/missing ids rather than trust them.
      let id: string;
      try {
        id = validateSnapshotId(raw.id);
      } catch {
        continue;
      }

      // Re-confirm the profileId tag matches EXACTLY. Kopia emits user tags as
      // `tag:<key>` in the `tags` map.
      const tags = raw.tags;
      if (typeof tags !== "object" || tags === null) continue;
      const tagValue = (tags as Record<string, unknown>)[`${KOPIA_TAG_PREFIX}profileId`];
      if (tagValue !== validProfileId) continue;

      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, profileId: validProfileId, raw });
    }
    return out;
  }

  /**
   * Idempotently delete ONLY the snapshot manifests belonging to a single
   * profile. This is a LOGICAL deletion: it removes snapshot manifests via
   * `kopia snapshot delete <id>... --delete`. It never touches raw S3
   * objects/chunks — physical reclamation of unreferenced content is an
   * eventual, repository-wide effect of {@link runMaintenance} (blob GC), which
   * is NOT run here.
   *
   * Flow (list once, then delete exact validated ids):
   *   1. `listProfileSnapshots(profileId)` — validated tag filter + client-side
   *      re-check. If it yields zero ids, this is a no-op success (idempotent:
   *      already absent is fine).
   *   2. Build a delete argv from the EXACT validated ids and run it once.
   *
   * Because only ids re-confirmed to carry this profile's tag are passed, no
   * other profile's snapshots can be deleted.
   */
  async deleteProfileSnapshots(
    profileId: string,
    run?: RunOptions,
  ): Promise<DeleteProfileSnapshotsResult> {
    const validProfileId = validateId(profileId, "profileId");
    const snapshots = await this.listProfileSnapshots(validProfileId, run);
    const ids = snapshots.map((s) => s.id);

    if (ids.length === 0) {
      // Idempotent: nothing to delete is success.
      return { profileId: validProfileId, deletedIds: [], deleted: 0 };
    }

    const args = buildSnapshotDeleteArgs(this.opts.global, { ids });
    this.ensureOk("snapshot delete", await this.exec(args, run));
    return { profileId: validProfileId, deletedIds: ids, deleted: ids.length };
  }

  /**
   * `kopia maintenance run [--full] [--safety=<level>]` — repository-wide
   * physical maintenance (blob GC of content made unreferenced by manifest
   * deletion). Exposed for completeness and operator-triggered reclamation;
   * this adapter NEVER invokes it implicitly. Shared-chunk GC is eventual and
   * not profile-scoped.
   */
  async runMaintenance(opts: MaintenanceRunOptions = {}, run?: RunOptions): Promise<void> {
    const args = buildMaintenanceRunArgs(this.opts.global, opts);
    this.ensureOk("maintenance run", await this.exec(args, run));
  }
}
