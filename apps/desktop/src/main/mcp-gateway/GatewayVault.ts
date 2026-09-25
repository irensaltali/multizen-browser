/**
 * Adapts the desktop's {@link CredentialVault} (OS-secure-storage backed, see
 * sync/CredentialVault.ts) to the three secret needs of the MCP gateway:
 *
 *   1. A gateway device Ed25519 signing key ({@link KeyVault}) used to sign
 *      project envelopes and the trust registry. The PRIVATE key never leaves
 *      the vault: it is generated once, stored as PKCS#8 PEM under a reserved
 *      credential name, and every `sign` call reconstructs a transient
 *      KeyObject from it. No caller can extract the private key through this
 *      surface, and it never crosses IPC.
 *
 *   2. Per-project device-local bearer tokens for the optional project auth.
 *      Tokens are opaque 256-bit hex secrets stored under a per-project
 *      credential name. Callers can generate, read (only for internal
 *      constant-time comparison / one-shot reveal), test presence, and delete —
 *      the token value itself is NEVER returned across IPC by the controller.
 *
 *   3. The per-repository sync salt (NOT secret, but conveniently colocated so
 *      it survives with the device identity). Generated once and reused so a
 *      fresh device derives the identical config-encryption key from the same
 *      operator password.
 *
 * All three live behind reserved credential-name prefixes so they never collide
 * with Cloud Sync's own secrets (kopia password, S3 keys) in the same vault.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  type KeyObject,
} from "node:crypto";

import {
  assertBundleable,
  deviceIdFromPublicKey,
  generateSaltHex,
  publicKeyHexFrom,
  selectBundleableNames,
  type BundleScope,
  type CredentialEntry,
  type KeyVault,
  type PublicKeyHex,
  type SigningKey,
} from "@multizen/mcp-gateway";

import type { CredentialVault } from "../sync/CredentialVault.ts";

/** Reserved credential-name namespace for gateway secrets in the shared vault. */
const PREFIX = "mcp-gateway:";
/** Device Ed25519 signing key, stored as PKCS#8 PEM. */
const SIGNING_KEY_NAME = `${PREFIX}device-signing-key-pem`;
/** Per-repository config-sync salt (hex). Not secret; colocated for durability. */
const SALT_NAME = `${PREFIX}sync-salt-hex`;
/** Per-project bearer-token credential name. */
export function projectTokenName(projectId: string): string {
  return `${PREFIX}project-token:${projectId}`;
}
/**
 * Per-project managed-secret credential name for one `${NAME}` reference.
 *
 * Managed secrets back an env/header reference with a value MultiZen stores in
 * OS secure storage instead of reading from the host environment. They are
 * scoped per project so two projects may reference the same NAME with different
 * values, and so deleting a project can drop exactly its own secrets.
 */
export function projectSecretName(projectId: string, envName: string): string {
  return `${PREFIX}project-secret:${projectId}:${envName}`;
}
const SECRET_PREFIX = `${PREFIX}project-secret:`;
/**
 * Passphrase for the opt-in credential bundle. Stored locally so the backup can
 * be refreshed whenever a secret changes without prompting the operator every
 * time; its presence IS the feature's on/off state, so there is no separate flag
 * that could drift out of step with it.
 */
const BUNDLE_PASSPHRASE_NAME = `${PREFIX}credential-bundle-passphrase`;

/**
 * The reference NAME that backs a raw value typed directly into a server's
 * environment/header field.
 *
 * The operator pastes a token; MultiZen stores it in OS secure storage and puts
 * only `${NAME}` in the project config, so the value never reaches disk in a
 * config file and never syncs. The name must therefore be DERIVED — stable for
 * the same (server, key) so re-saving overwrites one vault entry rather than
 * orphaning a trail of them, and identical on every device so a synced config's
 * reference resolves against the local value.
 *
 * A six-hex digest of the exact inputs is appended because the sanitising map is
 * lossy: server `a-b` key `X` and server `a_b` key `X` both flatten to
 * `A_B_X`, and two different secrets must never share one vault entry.
 */
export function managedRefName(serverId: string, key: string): string {
  const flatten = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const digest = createHash("sha256").update(`${serverId}\u0000${key}`).digest("hex").slice(0, 6);
  return `MULTIZEN_${flatten(serverId)}_${flatten(key)}_${digest.toUpperCase()}`;
}

/**
 * Gateway-facing view over a {@link CredentialVault}. Holds NO secret in memory
 * beyond the transient lifetime of a signing operation.
 */
export class GatewayVault implements KeyVault {
  private cached: SigningKey | null = null;

  constructor(private readonly vault: CredentialVault) {}

  /**
   * Return the device signing key, generating + persisting a new Ed25519 key
   * pair (as PKCS#8 PEM) on first use. Idempotent. The private key material is
   * read from the vault only to reconstruct a transient KeyObject per sign and
   * is never exposed.
   */
  async getOrCreateSigningKey(): Promise<SigningKey> {
    if (this.cached) return this.cached;
    let pem = await this.vault.get(SIGNING_KEY_NAME);
    if (pem === null) {
      const { privateKey } = generateKeyPairSync("ed25519");
      pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      await this.vault.set(SIGNING_KEY_NAME, pem);
    }
    const priv: KeyObject = createPrivateKey(pem);
    const pub = createPublicKey(priv);
    const publicKeyHex = publicKeyHexFrom(pub);
    const deviceId = deviceIdFromPublicKey(publicKeyHex);
    this.cached = {
      deviceId,
      publicKeyHex,
      sign: async (message: Uint8Array): Promise<string> =>
        // Reconstruct a fresh KeyObject per call from the stored PEM so no raw
        // private-key buffer is retained in the closure beyond the vault read.
        edSign(null, message, createPrivateKey(pem as string)).toString("hex"),
    };
    return this.cached;
  }

  /** The device's public key hex (creates the key if needed). */
  async publicKeyHex(): Promise<PublicKeyHex> {
    return (await this.getOrCreateSigningKey()).publicKeyHex;
  }

  /** The device id derived from the signing key (creates it if needed). */
  async deviceId(): Promise<string> {
    return (await this.getOrCreateSigningKey()).deviceId;
  }

  // ── per-repository sync salt ────────────────────────────────────────────

  /** Get the sync salt, generating + persisting one on first use. Idempotent. */
  async getOrCreateSaltHex(): Promise<string> {
    const existing = await this.vault.get(SALT_NAME);
    if (existing !== null && /^[0-9a-f]{64}$/.test(existing)) return existing;
    const salt = generateSaltHex();
    await this.vault.set(SALT_NAME, salt);
    return salt;
  }

  // ── per-project local-auth bearer tokens ────────────────────────────────

  /**
   * Generate and persist a fresh 256-bit hex bearer token for a project,
   * overwriting any existing one. Returns the new token so the caller can do a
   * single explicit one-shot reveal to the operator; it is not stored anywhere
   * else and future reads are for internal comparison only.
   */
  async generateProjectToken(projectId: string): Promise<string> {
    const token = randomBytes(32).toString("hex");
    await this.vault.set(projectTokenName(projectId), token);
    return token;
  }

  /** Read a project's bearer token for internal constant-time comparison. */
  async getProjectToken(projectId: string): Promise<string | null> {
    return this.vault.get(projectTokenName(projectId));
  }

  /** True when a device-local token secret is stored for this project. */
  async hasProjectToken(projectId: string): Promise<boolean> {
    return this.vault.has(projectTokenName(projectId));
  }

  /** Remove a project's bearer token. No-op if absent. */
  async deleteProjectToken(projectId: string): Promise<void> {
    await this.vault.delete(projectTokenName(projectId));
  }

  // ── per-project managed secrets (backing `${NAME}` references) ──────────

  /**
   * Store (or overwrite) the value backing one `${NAME}` reference for a
   * project. WRITE-ONLY from the caller's perspective: the value is handed to
   * OS secure storage and is only ever read back internally by the runtime when
   * launching/connecting an upstream. It is never returned across IPC.
   */
  async setManagedSecret(projectId: string, envName: string, value: string): Promise<void> {
    await this.vault.set(projectSecretName(projectId, envName), value);
  }

  /** Internal-only read used by runtime resolution. Never cross IPC with this. */
  async getManagedSecret(projectId: string, envName: string): Promise<string | null> {
    return this.vault.get(projectSecretName(projectId, envName));
  }

  /** True when a MultiZen-managed value is stored for this reference. */
  async hasManagedSecret(projectId: string, envName: string): Promise<boolean> {
    return this.vault.has(projectSecretName(projectId, envName));
  }

  /** Remove one managed secret. No-op if absent. */
  async deleteManagedSecret(projectId: string, envName: string): Promise<void> {
    await this.vault.delete(projectSecretName(projectId, envName));
  }

  /**
   * The reference NAMES that have a managed value for a project (never values).
   * Used to report presence in views and to purge a deleted project's secrets.
   */
  async managedSecretNames(projectId: string): Promise<string[]> {
    const prefix = `${SECRET_PREFIX}${projectId}:`;
    const names = await this.vault.names();
    return names
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length))
      .sort();
  }

  /** Delete every managed secret of a project (called on project deletion). */
  async deleteAllManagedSecrets(projectId: string): Promise<void> {
    for (const envName of await this.managedSecretNames(projectId)) {
      await this.vault.delete(projectSecretName(projectId, envName));
    }
  }

  // ── credential bundle (opt-in secret backup) ────────────────────────────

  /**
   * Store the bundle passphrase. Write-only: there is no accessor that returns it
   * to a caller outside this class beyond {@link bundlePassphrase}, which exists
   * solely so the sync layer can seal with it and is never routed over IPC.
   */
  async setBundlePassphrase(passphrase: string): Promise<void> {
    await this.vault.set(BUNDLE_PASSPHRASE_NAME, passphrase);
  }

  /** Internal-only read used to seal/open the bundle. Never cross IPC with this. */
  async bundlePassphrase(): Promise<string | null> {
    return this.vault.get(BUNDLE_PASSPHRASE_NAME);
  }

  /** True when credential backup is switched on for this device. */
  async hasBundlePassphrase(): Promise<boolean> {
    return this.vault.has(BUNDLE_PASSPHRASE_NAME);
  }

  /** Forget the passphrase, switching credential backup off. */
  async clearBundlePassphrase(): Promise<void> {
    await this.vault.delete(BUNDLE_PASSPHRASE_NAME);
  }

  /**
   * The credential names in this vault that a bundle is allowed to carry.
   *
   * The full name list is deliberately NOT exposed: filtering happens in here so
   * no caller ever holds a list containing the S3 keys or the signing key, and so
   * the allowlist is applied at the vault boundary rather than trusted to be
   * applied by whoever asks.
   */
  async bundleableNames(scope: BundleScope = {}): Promise<string[]> {
    return selectBundleableNames(await this.vault.names(), scope);
  }

  /**
   * Read every bundleable credential as name/value pairs, for sealing.
   *
   * A name that has disappeared between listing and reading is skipped rather
   * than recorded as an empty value — an empty string is a legitimate secret and
   * must not be manufactured.
   */
  async collectBundleEntries(scope: BundleScope = {}): Promise<CredentialEntry[]> {
    const out: CredentialEntry[] = [];
    for (const name of await this.bundleableNames(scope)) {
      const value = await this.vault.get(name);
      if (value === null) continue;
      out.push({ name, value });
    }
    return out;
  }

  /**
   * Write one restored credential. Re-asserts admission so a restore can never
   * write outside the bundleable namespace, even if the record it came from was
   * signed by a trusted device.
   */
  async writeBundleableCredential(
    name: string,
    value: string,
    scope: BundleScope = {},
  ): Promise<void> {
    assertBundleable(name, scope);
    await this.vault.set(name, value);
  }
}
