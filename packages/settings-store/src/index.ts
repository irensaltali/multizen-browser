import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Which Chromium-derived binary the bootstrap downloads on first run.
 *   - "cft": Chrome for Testing — Google's official automation channel,
 *     same binary Puppeteer/Playwright use. Stable, reproducible, but
 *     no anti-detect patches (CFT branding, vanilla TLS fingerprint).
 *   - "cloakbrowser": CloakBrowser — Chromium with 50+ source-level
 *     stealth patches (canvas farbling, WebRTC, CDP traces removed).
 *     Drops detection rate against Cloudflare/DataDome/Akamai. Binary
 *     is "free to use, no redistribution" — we auto-download to user
 *     machine, never bundle. Slightly older Mac builds (145 vs 148 CFT).
 */
export type BrowserEngine = "cft" | "cloakbrowser";

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
   * Automatically check for + stage new versions of the downloaded Chromium
   * ENGINE (CloakBrowser / Chrome for Testing) in the background. A staged
   * engine applies on the next profile launch; running browsers are never
   * interrupted. Manual "Check for updates" works regardless of this flag.
   */
  engineAutoUpdate: boolean;
  /**
   * Opt-in anonymous usage heartbeat. OFF by default — for an anti-detect
   * audience any call-home must be an explicit choice. When on, the app sends
   * at most one ping/day carrying only app version + OS family + an ephemeral
   * single-use nonce — no persistent id, no IP sent. The MULTIZEN_NO_TELEMETRY
   * env var force-disables it regardless. See docs/TELEMETRY.md.
   */
  usageReporting: boolean;
  /**
   * Non-secret Cloud Sync configuration. Backwards-compatible: absent in older
   * settings.json files, filled with defaults on load (see {@link SYNC_DEFAULTS}).
   */
  sync: SyncConfig;
}

/**
 * Non-secret Cloud Sync configuration.
 *
 * CRITICAL: nothing here is a secret. Worker URL, Access *client id* (public
 * half of a service-token pair — the secret half lives in the OS keychain via
 * the CredentialVault), S3/R2 endpoint/region/bucket/prefix, and credential
 * *reference names* (pointers to vault entries, never the values). The device
 * id + display name are generated once and persisted so a device keeps a
 * stable identity across launches.
 *
 * Every field is optional / defaulted so existing settings.json files (which
 * predate sync) load unchanged and sync stays dormant until the user fills it
 * in. `enabled` gates the whole feature globally; per-profile opt-in is tracked
 * separately in the profile-manager's `profile_sync_state`.
 */
export interface SyncConfig {
  /** Master switch for the sync feature. Off by default. */
  enabled: boolean;
  /** Coordination backend base URL, e.g. `https://sync.example.com`. */
  workerUrl: string;
  /**
   * Cloudflare Access service-token client id (the public half). Sent as the
   * `CF-Access-Client-Id` header. The secret half is stored in the vault under
   * {@link SyncConfig.accessClientSecretRef}.
   */
  accessClientId: string;
  /** S3/R2 endpoint host, e.g. `<account>.r2.cloudflarestorage.com`. */
  s3Endpoint: string;
  /** S3/R2 region. R2 typically uses `auto`. */
  s3Region: string;
  /** S3/R2 bucket name that holds the Kopia repository. */
  s3Bucket: string;
  /** Object key prefix inside the bucket. */
  s3Prefix: string;
  /**
   * Permanent, non-hardware-derived device id. Generated once on first load and
   * persisted. Matches the backend's `device_<...>`-tolerant charset.
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
  /** Vault entry name for the Access service-token client secret. */
  accessClientSecretRef: string;
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

/**
 * Default non-secret sync config. Everything empty / disabled so sync is
 * dormant until the user configures it. `deviceId` and `deviceDisplayName` are
 * intentionally NOT defaulted here — they are minted per-install in
 * {@link normalizeSync} so each device gets a unique, stable identity.
 */
export const SYNC_DEFAULTS: Omit<SyncConfig, "deviceId" | "deviceDisplayName"> = {
  enabled: false,
  workerUrl: "",
  accessClientId: "",
  s3Endpoint: "",
  s3Region: "auto",
  s3Bucket: "",
  s3Prefix: "",
  kopiaPasswordRef: "kopiaPassword",
  s3AccessKeyIdRef: "s3AccessKeyId",
  s3SecretAccessKeyRef: "s3SecretAccessKey",
  accessClientSecretRef: "accessClientSecret",
  kopiaConfigPath: "",
  kopiaBinPath: "",
};

/** Fields a caller may not mutate via update (identity is minted once). */
const NON_SECRET_STRING_KEYS = [
  "workerUrl",
  "accessClientId",
  "s3Endpoint",
  "s3Region",
  "s3Bucket",
  "s3Prefix",
  "deviceDisplayName",
  "kopiaConfigPath",
  "kopiaBinPath",
] as const;

/**
 * Merge a persisted (possibly-absent / partial) sync blob with defaults,
 * minting a stable device identity on first run. Never throws; coerces bad
 * types back to defaults so a corrupt file cannot brick the app.
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
  const outRec = out as unknown as Record<string, unknown>;
  for (const key of NON_SECRET_STRING_KEYS) {
    if (key === "deviceDisplayName") continue;
    const v = (r as Record<string, unknown>)[key];
    if (typeof v === "string") outRec[key] = v;
  }
  // Ref names: only accept safe, non-empty overrides; otherwise keep defaults.
  for (const key of [
    "kopiaPasswordRef",
    "s3AccessKeyIdRef",
    "s3SecretAccessKeyRef",
    "accessClientSecretRef",
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
  // Prefer CloakBrowser as the primary runtime. Chrome for Testing stays
  // available as a compatibility fallback from Settings.
  browserEngine: "cloakbrowser",
  autoUpdate: true,
  engineAutoUpdate: true,
  // Opt-in. Never phone home unless the user explicitly turns this on.
  usageReporting: false,
  // Sync is dormant by default; identity is minted on first load.
  sync: normalizeSync(undefined),
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
    if (merged.browserEngine !== "cft" && merged.browserEngine !== "cloakbrowser") {
      merged.browserEngine = DEFAULTS.browserEngine;
    }
    if (typeof merged.autoUpdate !== "boolean") {
      merged.autoUpdate = DEFAULTS.autoUpdate;
    }
    if (typeof merged.engineAutoUpdate !== "boolean") {
      merged.engineAutoUpdate = DEFAULTS.engineAutoUpdate;
    }
    if (typeof merged.usageReporting !== "boolean") {
      merged.usageReporting = DEFAULTS.usageReporting;
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
    this.cache = merged;
    if (!hadSync) {
      // Best-effort persist of the freshly-minted identity; ignore write errors
      // (read-only FS shouldn't block startup — identity re-mints next launch).
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
