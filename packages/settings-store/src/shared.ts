/**
 * Which application settings belong to the account and which belong to a device.
 *
 * Syncing `AppSettings` wholesale would be wrong in both directions. Some fields
 * describe a preference the operator expects everywhere (theme, whether the MCP
 * HTTP transport runs, update behaviour). Others describe THIS machine, and
 * copying them across would actively break things:
 *
 *   - `browserEngine` selects a Chromium binary; the right choice differs by
 *     platform and by what has been downloaded locally.
 *   - `mcpHttpPort` is a local listener; two machines may need different ports,
 *     and overwriting it can collide with something else on the receiving host.
 *   - the whole `sync` block holds this device's identity (`deviceId`,
 *     `deviceDisplayName`) plus bucket coordinates and vault REFERENCE NAMES.
 *     Device identity must stay unique or the trust registry and the lease
 *     system both break, and bucket credentials are what you need in order to
 *     reach the bucket in the first place — they cannot travel inside it.
 *
 * So the split is explicit and allow-listed: only {@link SHARED_SETTINGS_KEYS}
 * is ever published, and a restore merges those keys into the local settings
 * while leaving everything else untouched.
 */

import type { AppSettings } from "./index.js";

/** Settings that describe the account and are safe to share across devices. */
export interface SharedSettings {
  readonly theme: "dark";
  readonly mcpHttpEnabled: boolean;
  readonly autoUpdate: boolean;
  readonly engineAutoUpdate: boolean;
}

/**
 * The exact set of keys that sync. Anything absent from this list stays local by
 * default, so a field added to AppSettings later cannot start travelling by
 * accident — it has to be added here deliberately.
 */
export const SHARED_SETTINGS_KEYS = [
  "theme",
  "mcpHttpEnabled",
  "autoUpdate",
  "engineAutoUpdate",
] as const satisfies ReadonlyArray<keyof SharedSettings>;

/**
 * Keys that must NEVER be published, named explicitly so the invariant is
 * testable rather than merely implied by the shared list.
 */
export const DEVICE_LOCAL_SETTINGS_KEYS = [
  "browserEngine",
  "mcpHttpPort",
  "sync",
] as const;

/** Project the local settings onto the shared subset, ready to publish. */
export function toSharedSettings(settings: AppSettings): SharedSettings {
  return {
    theme: settings.theme,
    mcpHttpEnabled: settings.mcpHttpEnabled,
    autoUpdate: settings.autoUpdate,
    engineAutoUpdate: settings.engineAutoUpdate,
  };
}

/**
 * Validate a decoded shared-settings document.
 *
 * This is remote input, so every field is checked and anything unrecognised is
 * dropped rather than trusted. Missing fields are simply absent from the result:
 * an older device that published a smaller document must not blank out settings
 * it never knew about, which is what makes the schema forward-compatible.
 */
export function parseSharedSettings(raw: unknown): Partial<SharedSettings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (r.theme === "dark") out.theme = "dark";
  if (typeof r.mcpHttpEnabled === "boolean") out.mcpHttpEnabled = r.mcpHttpEnabled;
  if (typeof r.autoUpdate === "boolean") out.autoUpdate = r.autoUpdate;
  if (typeof r.engineAutoUpdate === "boolean") out.engineAutoUpdate = r.engineAutoUpdate;
  return out as Partial<SharedSettings>;
}

/**
 * Build the patch that applies an incoming shared document to local settings.
 *
 * Returns only the keys that actually differ, so an unchanged document produces
 * an empty patch and therefore no write and no cache invalidation. Device-local
 * fields are structurally unreachable from here: the patch type only admits
 * shared keys.
 */
export function sharedSettingsPatch(
  current: AppSettings,
  incoming: Partial<SharedSettings>,
): Partial<SharedSettings> {
  const patch: Record<string, unknown> = {};
  for (const key of SHARED_SETTINGS_KEYS) {
    const next = incoming[key];
    if (next === undefined) continue;
    if (current[key] === next) continue;
    patch[key] = next;
  }
  return patch as Partial<SharedSettings>;
}

/** True when two shared-settings snapshots are equivalent. */
export function sharedSettingsEqual(a: SharedSettings, b: SharedSettings): boolean {
  return SHARED_SETTINGS_KEYS.every((k) => a[k] === b[k]);
}

/**
 * Assert a value carries no device-local settings. Used before publishing so a
 * mistake becomes a loud failure instead of a silent leak of bucket coordinates
 * or a device identity into a shared object.
 */
export function assertNoDeviceLocalSettings(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if ((DEVICE_LOCAL_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new Error(`shared settings must not contain device-local key "${key}"`);
    }
  }
}
