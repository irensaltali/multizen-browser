/**
 * Application-settings synchronisation.
 *
 * Only the shared subset travels (see `@multizen/settings-store`'s shared.ts for
 * which fields and why). This module is the plumbing around that decision:
 *
 *   - publish the shared subset whenever it changes locally, skipping the write
 *     when nothing actually differs so an idle app does not churn revisions;
 *   - on a sync pass, apply an incoming document as a patch that can only touch
 *     shared keys, leaving this device's engine choice, listener port, identity
 *     and bucket coordinates alone.
 *
 * Conflicts are resolved by last-writer for settings, and deliberately so: a
 * preference is a single scalar with no meaningful merge, and asking the operator
 * to arbitrate "dark vs dark" would be noise. That is a different judgement from
 * project configs, where a clash can mean two real bodies of work and is
 * therefore surfaced. The cost is that two devices toggling the same preference
 * at once settle on one of the two values, which is the expected outcome anyway.
 */

import {
  assertNoDeviceLocalSettings,
  parseSharedSettings,
  sharedSettingsEqual,
  sharedSettingsPatch,
  toSharedSettings,
  type AppSettings,
  type SharedSettings,
} from "@multizen/settings-store";
import type { JsonValue } from "@multizen/mcp-gateway";

import type { GatewayService } from "./GatewayService.ts";

/** Document name under the shared scope. */
export const SETTINGS_DOCUMENT = "settings" as const;

export interface SettingsSyncDeps {
  readonly service: GatewayService;
  /** Current settings, read fresh each time (the cache identity changes). */
  readonly getSettings: () => AppSettings;
  /**
   * Apply a shared-key patch. Returns the new settings so the owner's cache can
   * be refreshed — `SettingsStore.update` replaces its cache object identity, so
   * handing the result back is required, not optional.
   */
  readonly applyPatch: (patch: Partial<SharedSettings>) => Promise<AppSettings>;
}

export interface SettingsPullOutcome {
  /** True when an incoming document changed something locally. */
  readonly applied: boolean;
  /** Keys that were changed, for logging and tests. */
  readonly changed: readonly string[];
  /** Why nothing happened, when nothing did. */
  readonly reason?: "not-syncing" | "absent" | "unchanged" | "rejected";
  /** Present when the document was refused; never carries a value. */
  readonly rejection?: string;
}

export class SettingsSync {
  /** Last snapshot published, so an unchanged save does not burn a revision. */
  private lastPublished: SharedSettings | null = null;

  constructor(private readonly deps: SettingsSyncDeps) {}

  /**
   * Publish the shared subset if it differs from the last thing we published.
   *
   * Returns true when a write was attempted. Failures are swallowed: settings are
   * authoritative locally, so a bucket problem must never block a preference
   * change, and the next pass will pick it up.
   */
  async push(): Promise<boolean> {
    const shared = toSharedSettings(this.deps.getSettings());
    if (this.lastPublished !== null && sharedSettingsEqual(this.lastPublished, shared)) {
      return false;
    }
    // Loud failure rather than a silent leak if the projection ever grows a
    // device-local field.
    assertNoDeviceLocalSettings(shared);
    const result = await this.deps.service
      .publishDocument("shared", SETTINGS_DOCUMENT, shared as unknown as JsonValue)
      .catch(() => null);
    if (result === null) return false;
    // Record the attempt either way: on a conflict the remote already holds a
    // newer document, and the next pull reconciles us to it.
    this.lastPublished = shared;
    return result.kind === "published";
  }

  /**
   * Apply the remote shared settings to this device.
   *
   * `expectFresh: false` is used on an explicit restore, where re-applying the
   * current revision onto a blank device is the whole point.
   */
  async pull(options: { expectFresh?: boolean } = {}): Promise<SettingsPullOutcome> {
    const read = await this.deps.service.readDocument<unknown>("shared", SETTINGS_DOCUMENT, {
      ...(options.expectFresh !== undefined ? { expectFresh: options.expectFresh } : {}),
    });
    if (read === null) return { applied: false, changed: [], reason: "not-syncing" };
    if (read.kind === "absent") return { applied: false, changed: [], reason: "absent" };
    if (read.kind === "rejected") {
      return {
        applied: false,
        changed: [],
        reason: "rejected",
        rejection: `${read.rejection.code}: ${read.rejection.reason}`,
      };
    }

    const incoming = parseSharedSettings(read.document.value);
    const patch = sharedSettingsPatch(this.deps.getSettings(), incoming);
    const changed = Object.keys(patch);
    if (changed.length === 0) return { applied: false, changed: [], reason: "unchanged" };

    await this.deps.applyPatch(patch);
    // Remember what the world now looks like, so the change we just accepted is
    // not immediately republished as if it were a local edit.
    this.lastPublished = toSharedSettings(this.deps.getSettings());
    return { applied: true, changed };
  }

  /**
   * One full reconcile: take the remote view first, then publish if this device
   * still differs. Pull-before-push means a device that has been offline adopts
   * the shared state rather than overwriting it with a stale snapshot.
   */
  async reconcile(options: { expectFresh?: boolean } = {}): Promise<SettingsPullOutcome> {
    const pulled = await this.pull(options);
    await this.push();
    return pulled;
  }
}
