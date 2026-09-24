/**
 * Hardened read → merge → backup → atomic-write → verify transaction for agent
 * workspace configuration files.
 *
 * Every agent adapter goes through this ONE mechanism, so the safety properties
 * are proven once rather than per format:
 *
 *   - **Canonicalization.** A workspace directory is resolved with `realpath`
 *     before anything is written, so the stored identity is stable and two
 *     spellings of the same directory cannot produce two sets of entries.
 *   - **Containment.** Target paths are built from fixed, validated segments and
 *     re-checked to still live inside the canonical workspace.
 *   - **Symlink refusal.** Every path component we would create or write is
 *     `lstat`-ed; a symlink anywhere in that chain aborts the write. Otherwise a
 *     symlinked `.mcp.json` (or `.cursor/`) could redirect our write outside the
 *     workspace entirely.
 *   - **Serialization.** Writes to one target path are queued, so two projects
 *     reconciling into the same file cannot interleave read-modify-write cycles
 *     and lose each other's entries.
 *   - **Concurrent-change detection.** The file is re-hashed immediately before
 *     the rename and compared to what the transform saw. A file edited by the
 *     user or another tool in between is left completely untouched.
 *   - **Backups.** The prior content is copied under `userData` (never into the
 *     workspace, so we do not pollute the user's repository) with a bounded,
 *     timestamped history per target.
 *   - **Atomicity + verification.** Content is written to a temp file in the
 *     SAME directory, fsynced, renamed over the target, then read back and
 *     compared. Only a verified write is reported as successful.
 *
 * This module is intentionally stateless about *ownership*. Which entry keys
 * belong to MultiZen is recorded once, per (project, directory, agent), in
 * {@link WorkspaceBindingStore}; duplicating that here would create a second
 * source of truth that could drift from the first.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type ConfigFileErrorCode =
  /** The workspace directory does not exist. */
  | "not-found"
  /** The workspace path exists but is not a directory. */
  | "not-a-directory"
  /** A path component we would write through is a symlink. */
  | "symlink-refused"
  /** A path segment was unsafe, or the target escaped the workspace. */
  | "traversal-refused"
  /** The file changed underneath us; nothing was written. */
  | "concurrent-modification"
  /** The filesystem refused the read/write. */
  | "permission"
  /** The renamed file did not read back as what we wrote. */
  | "verify-failed"
  /** Any other filesystem failure. */
  | "io"
  /** The existing file could not be parsed (raised by adapters). */
  | "malformed"
  /** A same-named entry exists that MultiZen does not own (adapters). */
  | "collision";

export class ConfigFileError extends Error {
  override readonly name = "ConfigFileError";
  constructor(
    message: string,
    readonly code: ConfigFileErrorCode,
    /** Actionable operator guidance, shown next to the error in the UI. */
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Wrap a filesystem failure in a classified {@link ConfigFileError}. */
function ioError(err: unknown, what: string): ConfigFileError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return new ConfigFileError(
      `permission denied ${what}`,
      "permission",
      "MultiZen cannot write here. Check the directory's permissions, or choose a different directory.",
    );
  }
  return new ConfigFileError(`${what} failed: ${(err as Error).message}`, "io");
}

/** SHA-256 of file bytes; the concurrent-change and verification fingerprint. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolve a workspace directory to its canonical absolute path.
 *
 * The directory ITSELF may legitimately be reached through a symlink (people
 * symlink their project roots); resolving it here is what makes the stored
 * identity stable. Symlink refusal applies to the components INSIDE the
 * workspace that we would create or write — see {@link resolveTargetPath}.
 */
export async function canonicalizeWorkspace(dir: string): Promise<string> {
  if (typeof dir !== "string" || dir.length === 0 || !path.isAbsolute(dir)) {
    throw new ConfigFileError(
      "a workspace directory must be an absolute path",
      "traversal-refused",
    );
  }
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigFileError(
        "that directory no longer exists",
        "not-found",
        "The folder may have been moved or deleted. Re-add it, or remove it from this project.",
      );
    }
    throw ioError(err, "resolving the directory");
  }
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(real);
  } catch (err) {
    throw ioError(err, "inspecting the directory");
  }
  if (!st.isDirectory()) {
    throw new ConfigFileError("that path is not a directory", "not-a-directory");
  }
  return real;
}

/** Reject an unsafe relative segment before it is ever joined onto a path. */
function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\u0000")
  ) {
    throw new ConfigFileError(
      `unsafe path segment ${JSON.stringify(segment)}`,
      "traversal-refused",
    );
  }
}

/**
 * Reject a symlink at any component of `parts` under `workspace`. Components
 * that do not exist yet are fine — we will create them as real directories.
 */
async function assertNoSymlinks(
  workspace: string,
  parts: readonly string[],
): Promise<void> {
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Not created yet (or an unreadable parent): nothing to reject here.
      if (code === "ENOENT") return;
      throw ioError(err, `inspecting ${part}`);
    }
    if (st.isSymbolicLink()) {
      throw new ConfigFileError(
        `refusing to write through the symlink ${current}`,
        "symlink-refused",
        "MultiZen will not write through a symlink, because it could redirect the " +
          "write outside your project. Replace it with a real file or directory.",
      );
    }
  }
}

/**
 * Build and validate the absolute path of one agent config file inside a
 * canonical workspace. `relativeParts` is the agent's fixed layout, e.g.
 * `[".cursor", "mcp.json"]`.
 */
export async function resolveTargetPath(
  workspace: string,
  relativeParts: readonly string[],
): Promise<string> {
  if (relativeParts.length === 0) {
    throw new ConfigFileError("a target path is required", "traversal-refused");
  }
  for (const part of relativeParts) assertSafeSegment(part);
  const target = path.join(workspace, ...relativeParts);
  // Defensive containment re-check: the joined path must still be inside.
  const rel = path.relative(workspace, target);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ConfigFileError(
      "the target path escaped its workspace directory",
      "traversal-refused",
    );
  }
  await assertNoSymlinks(workspace, relativeParts);
  return target;
}

/** A snapshot of a target file as the transform will see it. */
export interface FileSnapshot {
  /** Current text, or null when the file does not exist. */
  readonly content: string | null;
  /** Hash of `content`, or null when absent. */
  readonly hash: string | null;
  /** Existing file mode to preserve, or null when the file is new. */
  readonly mode: number | null;
}

/** Outcome of one applied transaction. */
export interface ApplyResult {
  readonly targetPath: string;
  /** False when the desired content already matched (idempotent no-op). */
  readonly changed: boolean;
  /** Hash of the file as verified on disk after the write. */
  readonly fileHash: string;
  /** Where the prior content was archived, when there was any. */
  readonly backupPath?: string;
}

/**
 * Produce the file's new full text from its current text (null when absent).
 * Adapters parse, merge only their owned entries, and re-serialize. Throwing a
 * {@link ConfigFileError} with `malformed`/`collision` aborts without writing.
 */
export type ConfigTransform = (current: string | null) => string | Promise<string>;

export interface ConfigFileTransactorOptions {
  /** Directory for archived prior content. MUST be outside any workspace. */
  readonly backupDir: string;
  /** Backups retained per target file. Default 10. */
  readonly maxBackups?: number;
  /** Injectable clock for deterministic backup names in tests. */
  readonly now?: () => number;
}

/** Mode for a config file we create. These files never contain secrets. */
const NEW_FILE_MODE = 0o644;

export class ConfigFileTransactor {
  private readonly backupDir: string;
  private readonly maxBackups: number;
  private readonly now: () => number;
  /** Per-target-path write queues. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: ConfigFileTransactorOptions) {
    this.backupDir = options.backupDir;
    this.maxBackups = options.maxBackups ?? 10;
    this.now = options.now ?? Date.now;
  }

  /** Queue `fn` behind any in-flight work for the same target path. */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    // Run regardless of whether the previous op resolved or rejected.
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  /** Read a target file's current text, hash, and mode. */
  async read(targetPath: string): Promise<FileSnapshot> {
    try {
      const st = await fs.lstat(targetPath);
      if (st.isSymbolicLink()) {
        throw new ConfigFileError(
          `refusing to read through the symlink ${targetPath}`,
          "symlink-refused",
          "MultiZen will not write through a symlinked config file. Replace it with a real file.",
        );
      }
      const content = await fs.readFile(targetPath, "utf8");
      return { content, hash: hashContent(content), mode: st.mode & 0o777 };
    } catch (err) {
      if (err instanceof ConfigFileError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { content: null, hash: null, mode: null };
      throw ioError(err, `reading ${path.basename(targetPath)}`);
    }
  }

  /**
   * Run one read → transform → backup → atomic write → verify cycle.
   *
   * Serialized per target path. When the transform's output already equals the
   * current content the file is left completely alone (no backup, no write), so
   * reconciliation is idempotent and does not churn backups.
   */
  async apply(targetPath: string, transform: ConfigTransform): Promise<ApplyResult> {
    return this.serialize(targetPath, async () => {
      const before = await this.read(targetPath);
      const next = await transform(before.content);

      if (before.content !== null && next === before.content) {
        return { targetPath, changed: false, fileHash: before.hash as string };
      }

      const dir = path.dirname(targetPath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        throw ioError(err, `creating ${path.basename(dir)}`);
      }

      // Archive the prior content BEFORE touching the target.
      let backupPath: string | undefined;
      if (before.content !== null) {
        backupPath = await this.backup(targetPath, before.content);
      }

      const mode = before.mode ?? NEW_FILE_MODE;
      const tmp = path.join(
        dir,
        `.${path.basename(targetPath)}.multizen-${randomSuffix()}.tmp`,
      );
      try {
        const handle = await fs.open(tmp, "wx", mode);
        try {
          await handle.writeFile(next, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw ioError(err, `writing ${path.basename(targetPath)}`);
      }

      try {
        // Last-moment concurrent-change check: if the file moved under us since
        // the transform read it, discard our work rather than clobber theirs.
        const current = await this.read(targetPath);
        if (current.hash !== before.hash) {
          throw new ConfigFileError(
            `${path.basename(targetPath)} changed while MultiZen was updating it`,
            "concurrent-modification",
            "The file was modified by you or another tool. Nothing was changed — retry to merge again.",
          );
        }
        // `mode` was set at create time; re-assert it so a restrictive umask
        // cannot silently narrow a file we are preserving.
        await fs.chmod(tmp, mode).catch(() => {});
        await fs.rename(tmp, targetPath);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        if (err instanceof ConfigFileError) throw err;
        throw ioError(err, `replacing ${path.basename(targetPath)}`);
      }

      // Verify by reading back: only a confirmed write counts as installed.
      const after = await this.read(targetPath);
      if (after.content !== next) {
        throw new ConfigFileError(
          `${path.basename(targetPath)} did not verify after writing`,
          "verify-failed",
          "The file on disk does not match what MultiZen wrote. Retry, or inspect the file.",
        );
      }
      return {
        targetPath,
        changed: true,
        fileHash: after.hash as string,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    });
  }

  /**
   * Copy prior content into the bounded backup history for a target, returning
   * the archive path. Backups live under `userData`, never in the workspace.
   */
  private async backup(targetPath: string, content: string): Promise<string> {
    const dir = path.join(this.backupDir, backupFolderFor(targetPath));
    try {
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `${stamp}-${randomSuffix()}.bak`);
      // 0600: a backup may mirror a file the user had locked down.
      await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
      await this.pruneBackups(dir);
      return file;
    } catch (err) {
      throw ioError(err, "archiving the previous configuration");
    }
  }

  /** Keep only the newest `maxBackups` archives for one target. */
  private async pruneBackups(dir: string): Promise<void> {
    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".bak")).sort();
    const excess = entries.length - this.maxBackups;
    for (let i = 0; i < excess; i += 1) {
      await fs.rm(path.join(dir, entries[i] as string), { force: true }).catch(() => {});
    }
  }

  /** List archived backups for a target, newest first. */
  async listBackups(targetPath: string): Promise<string[]> {
    const dir = path.join(this.backupDir, backupFolderFor(targetPath));
    try {
      const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".bak")).sort();
      return entries.reverse().map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }
}

/**
 * A stable, collision-free folder name for one target path's backups: a short
 * readable prefix plus a full digest of the absolute path.
 */
function backupFolderFor(targetPath: string): string {
  const digest = createHash("sha256").update(targetPath).digest("hex").slice(0, 16);
  const readable = path.basename(targetPath).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${readable}-${digest}`;
}

function randomSuffix(): string {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 10);
}
