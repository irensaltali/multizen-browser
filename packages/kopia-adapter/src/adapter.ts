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
  buildSnapshotCreateArgs,
  buildSnapshotListArgs,
  buildSnapshotRestoreArgs,
  type GlobalKopiaOptions,
  type RepositoryTarget,
  type SnapshotListOptions,
  type SnapshotTags,
} from "./commands.js";
import { buildChildEnv, secretValues, type KopiaSecrets } from "./env.js";
import { parseJson, parseJsonArray } from "./json.js";
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
}
