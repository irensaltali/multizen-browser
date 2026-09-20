/**
 * Local, encrypted credential vault for Cloud Sync secrets.
 *
 * Secrets (Kopia repo password, S3/R2 access keys, Access service-token
 * secret) NEVER touch settings.json or any manifest. They live here only,
 * encrypted at rest via Electron's {@link safeStorage} (Keychain-backed on
 * macOS, DPAPI on Windows, libsecret on Linux) and written with 0600
 * permissions.
 *
 * The vault is deliberately abstracted behind {@link CredentialVault} so the
 * controller and tests never depend on Electron: {@link FakeCredentialVault}
 * provides an in-memory implementation for node:test.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Names of the secrets a vault stores. Opaque strings — the vault does not
 *  interpret them, they are the "credential reference names" from settings. */
export type CredentialName = string;

/**
 * A minimal secret store. All values are strings; the store is responsible for
 * encryption-at-rest. `get` returns `null` for a missing key. Implementations
 * must never log or echo secret values.
 */
export interface CredentialVault {
  /** Store (or overwrite) a secret under `name`. */
  set(name: CredentialName, value: string): Promise<void>;
  /** Retrieve a secret, or `null` if not present. */
  get(name: CredentialName): Promise<string | null>;
  /** True when a secret exists for `name` (without returning its value). */
  has(name: CredentialName): Promise<boolean>;
  /** Remove a secret. No-op if absent. */
  delete(name: CredentialName): Promise<void>;
  /** List the names of stored secrets (never the values). */
  names(): Promise<CredentialName[]>;
}

/**
 * Subset of Electron's `safeStorage` we depend on. Declared structurally so the
 * module does not import electron at type-check time in non-electron contexts.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface VaultFileShape {
  /** Schema version for forward-compatible evolution. */
  version: 1;
  /** name -> base64(safeStorage-encrypted value). */
  entries: Record<string, string>;
}

/**
 * Encrypted file-backed vault. The on-disk file is a JSON object mapping each
 * credential name to a base64-encoded, safeStorage-encrypted blob. The whole
 * file is chmod 0600.
 *
 * If OS encryption is unavailable (e.g. a headless Linux without a keyring),
 * construction throws unless `allowPlaintextFallback` is set — we refuse to
 * silently store secrets in plaintext.
 */
export class SafeStorageCredentialVault implements CredentialVault {
  private cache: VaultFileShape | null = null;

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
  ) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS secure storage is unavailable; refusing to store sync secrets in plaintext",
      );
    }
    mkdirSync(dirname(filePath), { recursive: true });
  }

  private read(): VaultFileShape {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as VaultFileShape;
      if (parsed && typeof parsed === "object" && parsed.entries) {
        this.cache = { version: 1, entries: parsed.entries };
        return this.cache;
      }
    } catch {
      /* fall through to empty */
    }
    this.cache = { version: 1, entries: {} };
    return this.cache;
  }

  private write(shape: VaultFileShape): void {
    writeFileSync(this.filePath, JSON.stringify(shape), { mode: 0o600 });
    // writeFileSync mode only applies on create; enforce on every write.
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms (Windows) */
    }
    this.cache = shape;
  }

  async set(name: CredentialName, value: string): Promise<void> {
    const shape = this.read();
    const enc = this.safeStorage.encryptString(value).toString("base64");
    shape.entries[name] = enc;
    this.write(shape);
  }

  async get(name: CredentialName): Promise<string | null> {
    const shape = this.read();
    const enc = shape.entries[name];
    if (enc === undefined) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      // Corrupt / cross-machine blob — treat as absent rather than crash.
      return null;
    }
  }

  async has(name: CredentialName): Promise<boolean> {
    return this.read().entries[name] !== undefined;
  }

  async delete(name: CredentialName): Promise<void> {
    const shape = this.read();
    if (shape.entries[name] === undefined) return;
    delete shape.entries[name];
    this.write(shape);
  }

  async names(): Promise<CredentialName[]> {
    return Object.keys(this.read().entries);
  }
}

/** In-memory vault for tests. Never persists; never encrypts. */
export class FakeCredentialVault implements CredentialVault {
  private readonly store = new Map<string, string>();

  async set(name: CredentialName, value: string): Promise<void> {
    this.store.set(name, value);
  }
  async get(name: CredentialName): Promise<string | null> {
    return this.store.has(name) ? (this.store.get(name) as string) : null;
  }
  async has(name: CredentialName): Promise<boolean> {
    return this.store.has(name);
  }
  async delete(name: CredentialName): Promise<void> {
    this.store.delete(name);
  }
  async names(): Promise<CredentialName[]> {
    return [...this.store.keys()];
  }
}
