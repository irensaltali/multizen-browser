/**
 * Kopia binary resolution + adapter factory.
 *
 * Binary resolution precedence:
 *   1. explicit override (settings.sync.kopiaBinPath), if set + exists
 *   2. MULTIZEN_KOPIA_BIN env var (dev override), if set + exists
 *   3. packaged location under process.resourcesPath — the deterministic path
 *      the mac build embeds: `<resources>/kopia/kopia[.exe]`
 *      (electron-builder copies `resources/kopia/` → `<resources>/kopia/`).
 *      The legacy flat `<resources>/kopia[.exe]` is still probed as a fallback
 *      for older packaged builds.
 *   4. bare "kopia" (rely on PATH) as a last resort
 *
 * The factory wires a {@link KopiaAdapter} with a quiescence guard supplied by
 * the caller (the sync controller passes a guard backed by the browser driver).
 * Secrets are injected via env only — never argv (enforced by the adapter).
 *
 * This module does NOT download Kopia. If the resolved binary does not exist,
 * operations will fail at spawn time with a clear error; the resolver only
 * decides the path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  KopiaAdapter,
  type KopiaAdapterOptions,
  type KopiaSecrets,
  type QuiescenceGuard,
} from "@multizen/kopia-adapter";

export interface KopiaResolveOptions {
  /** Explicit user override from settings. Empty string = unset. */
  overridePath?: string;
  /** process.resourcesPath in a packaged app; undefined in dev. */
  resourcesPath?: string;
  /** Platform, for choosing the binary name. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Env accessor, injectable for tests. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Existence probe, injectable for tests. Defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
}

/**
 * The deterministic subdirectory under `process.resourcesPath` where the mac
 * build embeds the pinned Kopia binary. Kept in sync with the electron-builder
 * `extraResources` mapping (`resources/kopia` → `kopia`) and the fetch script's
 * default destination.
 */
export const KOPIA_PACKAGED_SUBDIR = "kopia";

/**
 * The single Kopia version MultiZen embeds. Kept as a runtime constant so the
 * diagnostics export can report the pinned version. MUST equal `KOPIA_VERSION`
 * in `scripts/kopia/kopiaAssets.mjs` (asserted by a unit test).
 */
export const KOPIA_PINNED_VERSION = "0.23.1";

/** Resolve the Kopia binary path per the documented precedence. */
export function resolveKopiaBinary(opts: KopiaResolveOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const binName = platform === "win32" ? "kopia.exe" : "kopia";

  const override = opts.overridePath?.trim();
  if (override && exists(override)) return override;

  const fromEnv = env.MULTIZEN_KOPIA_BIN?.trim();
  if (fromEnv && exists(fromEnv)) return fromEnv;

  if (opts.resourcesPath) {
    // Preferred deterministic path: <resources>/kopia/kopia[.exe].
    const packaged = join(opts.resourcesPath, KOPIA_PACKAGED_SUBDIR, binName);
    if (exists(packaged)) return packaged;
    // Legacy fallback: flat <resources>/kopia[.exe] from older builds.
    const legacy = join(opts.resourcesPath, binName);
    if (exists(legacy)) return legacy;
  }

  // Last resort: rely on PATH. Spawn will fail clearly if it isn't installed.
  return binName;
}

export interface KopiaFactoryOptions {
  bin: string;
  configFile: string;
  secrets: KopiaSecrets;
  guard: QuiescenceGuard;
  defaultTimeoutMs?: number;
  parentEnv?: Readonly<Record<string, string | undefined>>;
}

/** Build a configured KopiaAdapter. */
export function createKopiaAdapter(opts: KopiaFactoryOptions): KopiaAdapter {
  const adapterOpts: KopiaAdapterOptions = {
    bin: opts.bin,
    global: { configFile: opts.configFile },
    secrets: opts.secrets,
    guard: opts.guard,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? 120_000,
    parentEnv: opts.parentEnv,
  };
  return new KopiaAdapter(adapterOpts);
}
