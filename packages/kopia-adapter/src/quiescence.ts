/**
 * Quiescence guard.
 *
 * Snapshot and restore operations must only run when the underlying profile
 * data is quiescent (i.e. no browser process is actively writing to the
 * profile directory). This module defines the guard contract used by the
 * adapter and the error surfaced when a guard reports the resource busy.
 *
 * The adapter treats the guard as advisory-but-authoritative: if the guard
 * says "running", the operation is refused before any Kopia process spawns.
 */

/** Result of a quiescence check. */
export interface QuiescenceStatus {
  /** True when it is safe to read/write the profile (no active process). */
  readonly quiescent: boolean;
  /** Human-readable reason, useful when `quiescent` is false. */
  readonly reason?: string;
}

/**
 * Contract for determining whether a given profile/resource is safe to
 * snapshot or restore. Implementations might check a lock file, a process
 * table, or an in-memory registry of launched profiles.
 */
export interface QuiescenceGuard {
  /**
   * @param resourceId Opaque identifier for the resource being guarded
   *   (typically a profile id or its user-data directory path).
   */
  check(resourceId: string): Promise<QuiescenceStatus> | QuiescenceStatus;
}

/** Thrown when an operation is refused because the resource is not quiescent. */
export class ResourceBusyError extends Error {
  constructor(
    readonly resourceId: string,
    reason?: string,
  ) {
    super(
      reason
        ? `resource "${resourceId}" is not quiescent: ${reason}`
        : `resource "${resourceId}" is not quiescent`,
    );
    this.name = "ResourceBusyError";
  }
}

/**
 * Evaluate a guard and throw {@link ResourceBusyError} when the resource is
 * not quiescent. Returns normally when it is safe to proceed.
 */
export async function assertQuiescent(
  guard: QuiescenceGuard,
  resourceId: string,
): Promise<void> {
  const status = await guard.check(resourceId);
  if (!status.quiescent) {
    throw new ResourceBusyError(resourceId, status.reason);
  }
}

/** A guard that always reports quiescent. Useful for tests / offline flows. */
export const alwaysQuiescentGuard: QuiescenceGuard = {
  check(): QuiescenceStatus {
    return { quiescent: true };
  },
};
