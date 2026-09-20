/**
 * Profile quiescence guard for sync operations.
 *
 * Snapshot / restore must never run against a profile whose Chromium is still
 * writing. This guard implements the kopia-adapter's {@link QuiescenceGuard}
 * contract by consulting two independent signals:
 *
 *   1. the in-process registry (`browserDriver.isRunning`), and
 *   2. the OS process table for ANY process still holding this profile's
 *      `--user-data-dir` (catches re-parented / external Chromium windows the
 *      registry may not track).
 *
 * The `resourceId` passed by the adapter is the profile id; the guard maps it
 * to the on-disk data dir via the injected resolver.
 */

import type { QuiescenceGuard, QuiescenceStatus } from "@multizen/kopia-adapter";

/** Minimal surface the guard needs from the browser driver. */
export interface QuiescenceDriver {
  /** True when the profile is tracked as running in-process. */
  isRunning(profileId: string): boolean;
  /**
   * Count of OS processes still holding a `--user-data-dir` under the given
   * absolute profile data dir. 0 means quiescent.
   */
  countProcessesUsingDataDir(dataDir: string): Promise<number>;
}

export interface ProfileQuiescenceGuardOptions {
  driver: QuiescenceDriver;
  /** Resolve a profile id → its absolute on-disk data dir, or null if unknown. */
  resolveDataDir: (profileId: string) => string | null;
}

export class ProfileQuiescenceGuard implements QuiescenceGuard {
  constructor(private readonly opts: ProfileQuiescenceGuardOptions) {}

  async check(resourceId: string): Promise<QuiescenceStatus> {
    if (this.opts.driver.isRunning(resourceId)) {
      return { quiescent: false, reason: "browser is running for this profile" };
    }
    const dataDir = this.opts.resolveDataDir(resourceId);
    if (!dataDir) {
      // Unknown profile → conservatively allow (nothing to snapshot anyway).
      return { quiescent: true };
    }
    const lingering = await this.opts.driver.countProcessesUsingDataDir(dataDir);
    if (lingering > 0) {
      return {
        quiescent: false,
        reason: `${lingering} lingering process(es) still hold the profile data dir`,
      };
    }
    return { quiescent: true };
  }
}
