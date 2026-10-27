import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserEngine } from "@multizen/types";

export type { BrowserEngine };

/**
 * Linux sandbox secure-setup state.
 * - "unset": never decided; re-evaluate live each launch.
 * - "declined": user chose to launch without the sandbox; do not auto-prompt.
 * - "unsupported": the AppArmor secure setup cannot be performed on this system
 *   (reason surfaced once + kept visible in Settings); do not re-nag.
 * Only meaningful on Linux. "active" is never stored — it is verified live
 * against the OS at launch (a persisted flag must never be trusted).
 */
export type LinuxSandboxState = "unset" | "declined" | "unsupported";

export interface AppSettings {
  /** Theme — "dark" only for now, kept for forward compatibility */
  theme: "dark";
  /** Whether to spawn local MCP HTTP server on app start */
  mcpHttpEnabled: boolean;
  /** Port for MCP HTTP server */
  mcpHttpPort: number;
  /** Which Chromium binary to download + run. Switching requires app restart. */
  browserEngine: BrowserEngine;
  /**
   * Automatically check for + (on Windows/Linux) download app updates in the
   * background. On macOS the app can only notify, not auto-install. Manual
   * "Check for updates" works regardless of this flag.
   */
  autoUpdate: boolean;
  /**
   * Automatically check for + stage new versions of the downloaded browser
   * ENGINE (CloakBrowser / Camoufox) in the background. A staged engine
   * applies on the next profile launch; running browsers are never
   * interrupted. Manual "Check for updates" works regardless of this flag.
   */
  engineAutoUpdate: boolean;
  /** Device-local Linux sandbox setup decision. */
  linuxSandboxState: LinuxSandboxState;
  /**
   * Non-secret Cloud Sync configuration. Backwards-compatible: absent in older
   * settings.json files, filled with defaults on load (see {@link SYNC_DEFAULTS}).
   */
  sync: SyncConfig;
}

/**
 * Non-secret Cloud Sync configuration.
 *
 * CRITICAL: nothing here is a secret. The S3/R2 endpoint/region/bucket, the
 * Kopia object prefix, the separate coordination-control prefix, path-style
 * addressing, lease timing, and credential *reference names* (pointers to vault
 * entries, never the values). The device id + display name are generated once
 * and persisted so a device keeps a stable identity across launches.
 *
 * The control plane is now the conditional-write S3/R2 state coordinator
 * (`@multizen/s3-coordinator`) — there is NO Worker URL and NO Cloudflare
 * Access anymore. Legacy `workerUrl`/`accessClientId`/`accessClientSecretRef`
 * fields are ignored on load and never written back.
 *
 * Every field is optional / defaulted so existing settings.json files (which
 * predate sync) load unchanged and sync stays dormant until the user fills it
 * in. `enabled` gates the whole feature globally; per-profile opt-in is tracked
 * separately in the profile-manager's `profile_sync_state`.
 */
export interface SyncConfig {
  /** Master switch for the sync feature. Off by default. */
  enabled: boolean;
  /** S3/R2 endpoint host, e.g. `<account>.r2.cloudflarestorage.com`. */
  s3Endpoint: string;
  /** S3/R2 region. R2 typically uses `auto`. */
  s3Region: string;
  /** S3/R2 bucket name that holds the Kopia repository AND the control state. */
  s3Bucket: string;
  /** Object key prefix inside the bucket for the Kopia repository data. */
  s3Prefix: string;
  /**
   * Object key prefix for the conditional-write coordination control plane
   * (lease/revision state + history). MUST be separate from {@link s3Prefix}
   * so control objects never land inside Kopia's internal key namespace.
   * Default `multizen-control`.
   */
  controlPrefix: string;
  /** Path-style S3 addressing (R2 / MinIO commonly need this). Default false. */
  s3ForcePathStyle: boolean;
  /** Lease time-to-live in ms. Default 60000. */
  leaseTtlMs: number;
  /** Recommended lease renewal interval in ms. Default 15000. */
  renewalMs: number;
  /** Extra margin (ms) before an expired lease may be taken over. Default 10000. */
  clockSkewSafetyMs: number;
  /**
   * Permanent, non-hardware-derived device id. Generated once on first load and
   * persisted. Matches the coordinator's `device_<...>`-tolerant charset.
   */
  deviceId: string;
  /** Human-friendly device name shown in conflict-copy names and diagnostics. */
  deviceDisplayName: string;
  /** Vault entry name for the Kopia repository password. */
  kopiaPasswordRef: string;
  /** Vault entry name for the S3/R2 access key id. */
  s3AccessKeyIdRef: string;
  /** Vault entry name for the S3/R2 secret access key. */
  s3SecretAccessKeyRef: string;
  /**
   * Optional override for the Kopia config file path. Empty → a per-app default
   * under the user-data dir is used.
   */
  kopiaConfigPath: string;
  /**
   * Optional override for the Kopia binary path. Empty → resolver falls back to
   * MULTIZEN_KOPIA_BIN (dev) or the packaged resources path.
   */
  kopiaBinPath: string;
}

/** Default control prefix for the coordination state plane. */
export const DEFAULT_CONTROL_PREFIX = "multizen-control";
/** Default isolated prefix for Kopia repository data. */
export const DEFAULT_KOPIA_PREFIX = "multizen-kopia";

/**
 * Default non-secret sync config. Everything empty / disabled so sync is
 * dormant until the user configures it. `deviceId` and `deviceDisplayName` are
 * intentionally NOT defaulted here — they are minted per-install in
 * {@link normalizeSync} so each device gets a unique, stable identity.
 */
export const SYNC_DEFAULTS: Omit<SyncConfig, "deviceId" | "deviceDisplayName"> = {
  enabled: false,
  s3Endpoint: "",
  s3Region: "auto",
  s3Bucket: "",
  s3Prefix: DEFAULT_KOPIA_PREFIX,
  controlPrefix: DEFAULT_CONTROL_PREFIX,
  s3ForcePathStyle: false,
  leaseTtlMs: 60_000,
  renewalMs: 15_000,
  clockSkewSafetyMs: 10_000,
  kopiaPasswordRef: "kopiaPassword",
  s3AccessKeyIdRef: "s3AccessKeyId",
  s3SecretAccessKeyRef: "s3SecretAccessKey",
  kopiaConfigPath: "",
  kopiaBinPath: "",
};

/** Non-secret string fields a caller may set via update / load. */
const NON_SECRET_STRING_KEYS = [
  "s3Endpoint",
  "s3Region",
  "s3Bucket",
  "s3Prefix",
  "controlPrefix",
  "deviceDisplayName",
  "kopiaConfigPath",
  "kopiaBinPath",
] as const;

/** Numeric timing fields (positive integers) accepted from load / update. */
const POSITIVE_INT_KEYS = ["leaseTtlMs", "renewalMs", "clockSkewSafetyMs"] as const;

/**
 * Merge a persisted (possibly-absent / partial) sync blob with defaults,
 * minting a stable device identity on first run. Never throws; coerces bad
 * types back to defaults so a corrupt file cannot brick the app. Legacy
 * Worker/Access fields (`workerUrl`, `accessClientId`, `accessClientSecretRef`)
 * are IGNORED — they are never copied into the normalized config, so the next
 * load/update drops them from disk.
 */
export function normalizeSync(raw: Partial<SyncConfig> | undefined): SyncConfig {
  const r = raw ?? {};
  const deviceId =
    typeof r.deviceId === "string" && r.deviceId.length > 0
      ? r.deviceId
      : `device_${randomUUID().replace(/-/g, "")}`;
  const deviceDisplayName =
    typeof r.deviceDisplayName === "string" && r.deviceDisplayName.length > 0
      ? r.deviceDisplayName
      : "This device";
  const out: SyncConfig = {
    ...SYNC_DEFAULTS,
    deviceId,
    deviceDisplayName,
  };
  out.enabled = typeof r.enabled === "boolean" ? r.enabled : SYNC_DEFAULTS.enabled;
  out.s3ForcePathStyle =
    typeof r.s3ForcePathStyle === "boolean"
      ? r.s3ForcePathStyle
      : SYNC_DEFAULTS.s3ForcePathStyle;
  const outRec = out as unknown as Record<string, unknown>;
  for (const key of NON_SECRET_STRING_KEYS) {
    if (key === "deviceDisplayName") continue;
    const v = (r as Record<string, unknown>)[key];
    if (typeof v === "string") outRec[key] = v;
  }
  // Both namespaces must be non-empty. In particular, Kopia refuses to create
  // a repository at a bucket root that already contains coordination objects.
  if (typeof out.s3Prefix !== "string" || out.s3Prefix.trim().length === 0) {
    out.s3Prefix = DEFAULT_KOPIA_PREFIX;
  }
  if (typeof out.controlPrefix !== "string" || out.controlPrefix.trim().length === 0) {
    out.controlPrefix = DEFAULT_CONTROL_PREFIX;
  }
  for (const key of POSITIVE_INT_KEYS) {
    const v = (r as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0) {
      outRec[key] = v;
    }
  }
  // Ref names: only accept safe, non-empty overrides; otherwise keep defaults.
  for (const key of [
    "kopiaPasswordRef",
    "s3AccessKeyIdRef",
    "s3SecretAccessKeyRef",
  ] as const) {
    const v = (r as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) outRec[key] = v;
  }
  return out;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  mcpHttpEnabled: true,
  mcpHttpPort: 7777,
  // CloakBrowser is the default engine for newly created profiles.
  browserEngine: "cloakbrowser",
  autoUpdate: true,
  engineAutoUpdate: true,
  // Sync is dormant by default; identity is minted on first load.
  sync: normalizeSync(undefined),
  linuxSandboxState: "unset",
};

export class SettingsStore {
  private readonly jsonPath: string;
  private cache: AppSettings | null = null;

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    mkdirSync(dirname(jsonPath), { recursive: true });
  }

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;

    let raw: Partial<AppSettings> = {};
    if (existsSync(this.jsonPath)) {
      try {
        const txt = readFileSync(this.jsonPath, "utf8");
        raw = JSON.parse(txt) as Partial<AppSettings>;
      } catch {
        raw = {};
      }
    }

    const merged: AppSettings = { ...DEFAULTS, ...raw };
    // Legacy migration: the anonymous usage heartbeat feature was removed. Drop
    // any `usageReporting` key an older settings.json may carry so it never
    // lands in the normalized object and is not written back on the next
    // load/update. Deleting it here (after the spread) keeps every other
    // setting + sync field intact.
    delete (merged as unknown as Record<string, unknown>).usageReporting;
    if (merged.browserEngine !== "cloakbrowser" && merged.browserEngine !== "camoufox") {
      merged.browserEngine = DEFAULTS.browserEngine;
    }
    if (typeof merged.autoUpdate !== "boolean") {
      merged.autoUpdate = DEFAULTS.autoUpdate;
    }
    if (typeof merged.engineAutoUpdate !== "boolean") {
      merged.engineAutoUpdate = DEFAULTS.engineAutoUpdate;
    }
    // Sync config: backwards-compatible — normalize (and mint device identity
    // on first run). Persist immediately if a new identity was minted so it
    // stays stable across launches.
    const hadSync =
      typeof raw.sync === "object" &&
      raw.sync !== null &&
      typeof (raw.sync as Partial<SyncConfig>).deviceId === "string" &&
      ((raw.sync as Partial<SyncConfig>).deviceId as string).length > 0;
    merged.sync = normalizeSync(raw.sync);
    if (
      merged.linuxSandboxState !== "unset" &&
      merged.linuxSandboxState !== "declined" &&
      merged.linuxSandboxState !== "unsupported"
    ) {
      merged.linuxSandboxState = DEFAULTS.linuxSandboxState;
    }
    this.cache = merged;
    // Persist immediately when we minted a fresh identity OR when a legacy
    // `usageReporting` key was present on disk, so the removed feature is
    // scrubbed from settings.json on the very next load (not just on update).
    const hadLegacyUsageReporting =
      Object.prototype.hasOwnProperty.call(raw, "usageReporting");
    if (!hadSync || hadLegacyUsageReporting) {
      // Best-effort persist of the freshly-minted identity / scrubbed file;
      // ignore write errors (read-only FS shouldn't block startup — identity
      // re-mints next launch).
      try {
        writeFileSync(this.jsonPath, JSON.stringify(merged, null, 2), "utf8");
      } catch {
        /* ignore */
      }
    }
    return merged;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next = { ...current, ...patch };
    // Defensive: the anonymous usage heartbeat was removed. Never let a legacy
    // `usageReporting` key (from an old caller or persisted file) re-enter the
    // normalized object or get written back to disk.
    delete (next as unknown as Record<string, unknown>).usageReporting;
    // Deep-merge sync so a partial `{ sync: { workerUrl } }` patch preserves
    // the rest of the sync config (and never loses the device identity).
    if (patch.sync) {
      next.sync = normalizeSync({ ...current.sync, ...patch.sync });
    }
    this.cache = next;
    writeFileSync(this.jsonPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}

// Shared-vs-device split used by settings sync (see shared.ts for the rationale).
export {
  assertNoDeviceLocalSettings,
  DEVICE_LOCAL_SETTINGS_KEYS,
  parseSharedSettings,
  SHARED_SETTINGS_KEYS,
  sharedSettingsEqual,
  sharedSettingsPatch,
  toSharedSettings,
  type SharedSettings,
} from "./shared.js";
