/**
 * Atomic same-volume swap with rollback.
 *
 * Restoring a profile must be atomic: an interrupted restore must never leave
 * a half-written user-data directory in place of a good one. The strategy:
 *
 *   1. Restore fresh data into a *staging* directory that lives on the SAME
 *      volume as the live directory (so the final rename is atomic).
 *   2. Move the current live directory aside to a *backup* path (rename).
 *   3. Move staging into the live path (rename).
 *   4. On success, the backup can be discarded by the caller.
 *   5. On ANY failure after step 2, roll back by renaming backup -> live.
 *
 * `rename(2)` is atomic only within a single filesystem, so we assert that
 * staging, live, and backup are colocated on the same volume before starting.
 */

import { rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { statSync } from "node:fs";

export class SwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapError";
  }
}

export interface SwapPlan {
  /** Directory containing freshly-restored data, ready to become live. */
  readonly stagingDir: string;
  /** The live profile directory to be replaced. */
  readonly liveDir: string;
  /** Where the current live directory is moved before the swap. */
  readonly backupDir: string;
}

/**
 * Injectable filesystem operations so the swap logic can be unit tested with a
 * fake that simulates failures and records the operation order.
 */
export interface SwapFs {
  /** Return the device id for a path (or its nearest existing parent). */
  deviceId(path: string): Promise<number>;
  /** True if the path exists. */
  exists(path: string): Promise<boolean>;
  /** Atomic rename within a volume. */
  rename(from: string, to: string): Promise<void>;
  /** Recursively remove a path. */
  remove(path: string): Promise<void>;
}

/** Default {@link SwapFs} backed by node:fs/promises. */
export const nodeSwapFs: SwapFs = {
  async deviceId(path: string): Promise<number> {
    // Walk up to the nearest existing ancestor so we can compare the volume
    // even when the leaf (e.g. backup target) does not exist yet.
    let current = path;
    for (;;) {
      try {
        const s = await stat(current);
        return s.dev;
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          throw new SwapError(`cannot determine device id for ${path}`);
        }
        current = parent;
      }
    }
  },
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  },
  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

/** Synchronous device-id probe used only for early, cheap validation. */
export function sameVolumeSync(a: string, b: string): boolean {
  const devOf = (p: string): number => {
    let current = p;
    for (;;) {
      try {
        return statSync(current).dev;
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          throw new SwapError(`cannot determine device id for ${p}`);
        }
        current = parent;
      }
    }
  };
  return devOf(a) === devOf(b);
}

export interface SwapResult {
  /** Path where the previous live data now resides (the backup). */
  readonly backupDir: string;
}

/**
 * Perform the atomic swap described by {@link SwapPlan}.
 *
 * Preconditions (validated):
 *  - staging dir must exist.
 *  - staging, live, and backup must be on the same volume.
 *  - backup path must not already exist.
 *
 * On failure after the live dir has been moved aside, the original live
 * directory is restored from backup before the error propagates.
 */
export async function atomicSwap(
  plan: SwapPlan,
  fs: SwapFs = nodeSwapFs,
): Promise<SwapResult> {
  const { stagingDir, liveDir, backupDir } = plan;

  if (!(await fs.exists(stagingDir))) {
    throw new SwapError(`staging dir does not exist: ${stagingDir}`);
  }
  if (await fs.exists(backupDir)) {
    throw new SwapError(`backup dir already exists: ${backupDir}`);
  }

  // Same-volume checks: rename is only atomic within one filesystem.
  const stagingDev = await fs.deviceId(stagingDir);
  const liveParentDev = await fs.deviceId(dirname(liveDir));
  const backupParentDev = await fs.deviceId(dirname(backupDir));
  if (stagingDev !== liveParentDev) {
    throw new SwapError("staging dir and live dir are not on the same volume");
  }
  if (liveParentDev !== backupParentDev) {
    throw new SwapError("live dir and backup dir are not on the same volume");
  }

  const liveExisted = await fs.exists(liveDir);
  let movedLiveAside = false;

  try {
    if (liveExisted) {
      await fs.rename(liveDir, backupDir);
      movedLiveAside = true;
    }
    await fs.rename(stagingDir, liveDir);
    return { backupDir };
  } catch (err) {
    // Roll back: restore the original live directory if we moved it aside.
    if (movedLiveAside) {
      try {
        // Clear any partial live dir left by a failed staging rename.
        if (await fs.exists(liveDir)) {
          await fs.remove(liveDir);
        }
        await fs.rename(backupDir, liveDir);
      } catch (rollbackErr) {
        const reason = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new SwapError(
          `swap failed and rollback also failed (${reason}); ` +
            `original data is at ${backupDir}`,
        );
      }
    }
    const original = err instanceof Error ? err.message : String(err);
    throw new SwapError(`swap failed and was rolled back: ${original}`);
  }
}
