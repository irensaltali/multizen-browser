/**
 * Sanitized profile manifest.
 *
 * A manifest is the *non-secret, portable* description of a profile that is
 * safe to upload alongside a snapshot and to sync between devices. It
 * deliberately strips two classes of data:
 *
 *   1. Secrets — proxy credentials (`password`, and defensively `username`)
 *      must never leave the device inside a manifest. They live in the OS
 *      keychain / device-local storage only.
 *   2. Machine-local absolutes — `dataDir` is an absolute path that is
 *      meaningless (and privacy-leaking: it embeds the OS username/home) on
 *      another device. It is removed entirely; the receiving device
 *      re-derives its own dataDir.
 *
 * The functions here are pure and structural: they accept a minimal shape
 * rather than importing the app's browser `Profile` type, keeping this package
 * browser-independent while remaining compatible with it.
 */

/**
 * Structural view of one installed extension, compatible with the app's
 * `ExtensionConfig`.
 *
 * Extensions carry no secrets and no absolute paths — `dir` is relative to the
 * profile's own dataDir — so the whole record is portable. Which is why losing
 * them on restore was a plain bug rather than a deliberate exclusion.
 */
export interface ManifestExtensionInput {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  scope: "shared" | "profile";
  dir: string;
  source: "web-store" | "file" | "folder";
}

/** Structural proxy shape (compatible with the app's ProxyConfig). */
export interface ManifestProxyInput {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Proxy as it appears in a manifest: transport + endpoint only, no creds. */
export interface SanitizedProxy {
  type: "http" | "socks5";
  host: string;
  port: number;
  /**
   * Whether the source proxy carried credentials. Recorded so a receiving
   * device can prompt the user to re-enter them, without ever transmitting the
   * secret itself.
   */
  requiresCredentials: boolean;
}

/**
 * Minimal structural view of a profile the sanitizer accepts. Compatible with
 * the app's `Profile` (extra fields are ignored) but not dependent on it.
 */
export interface ProfileManifestInput {
  id: string;
  name: string;
  notes?: string;
  tags?: string[];
  proxy?: ManifestProxyInput;
  /** Opaque JSON-serializable fingerprint blob (no secrets, machine-portable). */
  fingerprint: unknown;
  icon?: string;
  startUrl?: string;
  searchProvider?: string;
  createdAt: string;
  updatedAt: string;
  /** Present on input; intentionally dropped from the manifest. */
  dataDir?: string;
  proxyCountry?: string;
  /** Installed extensions. Absent/empty is normal for a profile with none. */
  extensions?: readonly ManifestExtensionInput[];
}

/** The portable, secret-free profile manifest. */
export interface ProfileManifest {
  /** Manifest schema version, for forward-compatible evolution. */
  manifestVersion: 1;
  id: string;
  name: string;
  notes?: string;
  tags: string[];
  proxy?: SanitizedProxy;
  fingerprint: unknown;
  icon?: string;
  startUrl?: string;
  searchProvider?: string;
  proxyCountry?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Installed extensions, so a restored profile keeps them instead of coming
   * back empty. Only allow-listed fields are copied.
   *
   * `scope: "profile"` extensions have their files inside the profile's own data
   * directory, which the snapshot already carries, so they return intact.
   * `scope: "shared"` extensions reference the device-wide extension store; the
   * receiving device may not have those files, which the restore reports rather
   * than silently producing an entry that cannot load.
   */
  extensions?: ManifestExtension[];
}

/** One extension as stored in a manifest. Structurally the safe subset. */
export interface ManifestExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  scope: "shared" | "profile";
  dir: string;
  source: "web-store" | "file" | "folder";
}

/** Current manifest schema version. */
export const MANIFEST_VERSION = 1 as const;

/**
 * Copy only the allow-listed extension fields, so a future field added to the
 * app's ExtensionConfig can never ride along into a manifest unreviewed.
 */
export function sanitizeExtensions(
  extensions: readonly ManifestExtensionInput[] | undefined,
): ManifestExtension[] | undefined {
  if (!extensions || extensions.length === 0) return undefined;
  return extensions.map((e) => ({
    id: e.id,
    name: e.name,
    version: e.version,
    enabled: e.enabled,
    scope: e.scope,
    dir: e.dir,
    source: e.source,
  }));
}

/**
 * Sanitize a proxy for inclusion in a manifest: keep transport + endpoint,
 * strip both `password` and `username`, and record whether creds existed.
 */
export function sanitizeProxy(proxy: ManifestProxyInput | undefined): SanitizedProxy | undefined {
  if (!proxy) return undefined;
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    requiresCredentials: Boolean(proxy.username) || Boolean(proxy.password),
  };
}

/**
 * Produce a sanitized {@link ProfileManifest} from a profile.
 *
 * Guarantees (see {@link assertManifestSafe}):
 *   - no proxy `password`/`username` anywhere in the output,
 *   - no absolute `dataDir` field,
 *   - only allow-listed fields are copied (no accidental secret passthrough).
 */
export function toManifest(input: ProfileManifestInput): ProfileManifest {
  const manifest: ProfileManifest = {
    manifestVersion: MANIFEST_VERSION,
    id: input.id,
    name: input.name,
    tags: input.tags ?? [],
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  if (input.notes !== undefined) manifest.notes = input.notes;
  const proxy = sanitizeProxy(input.proxy);
  if (proxy) manifest.proxy = proxy;
  if (input.icon !== undefined) manifest.icon = input.icon;
  if (input.startUrl !== undefined) manifest.startUrl = input.startUrl;
  if (input.searchProvider !== undefined) manifest.searchProvider = input.searchProvider;
  if (input.proxyCountry !== undefined) manifest.proxyCountry = input.proxyCountry;
  const extensions = sanitizeExtensions(input.extensions);
  if (extensions) manifest.extensions = extensions;
  return manifest;
}

/**
 * Defensive invariant check: throws if a manifest (or any nested value) still
 * contains a proxy credential or an absolute-path `dataDir`. Intended for use
 * in tests and as a last line of defense before upload. Returns the manifest
 * unchanged on success for convenient chaining.
 */
export function assertManifestSafe(manifest: ProfileManifest): ProfileManifest {
  const seen = new Set<unknown>();
  const forbiddenKeys = new Set(["password", "dataDir"]);
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKeys.has(key)) {
        throw new Error(`Manifest is not safe: forbidden key "${key}" at ${path}.${key}`);
      }
      // `username` is only forbidden inside a proxy object; a manifest never
      // carries a bare username elsewhere, so block it defensively too.
      if (key === "username") {
        throw new Error(`Manifest is not safe: proxy username leaked at ${path}.${key}`);
      }
      walk(v, `${path}.${key}`);
    }
  };
  walk(manifest, "manifest");
  return manifest;
}
