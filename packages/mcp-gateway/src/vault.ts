/**
 * Private-key vault abstraction.
 *
 * The gateway signs project envelopes and trust registries with a device
 * Ed25519 key. The private key must never be serialized into any config,
 * envelope, or log. This interface confines all private-key material behind an
 * opaque handle: callers can sign but cannot extract the raw private key.
 *
 * Production implementations back this with the OS keychain / secure storage.
 * Tests use InMemoryVault which holds keys only in process memory and is never
 * persisted.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";

/** A device's public verification key, hex-encoded raw 32 bytes. */
export type PublicKeyHex = string & { readonly __brand: "PublicKeyHex" };

export interface SigningKey {
  /** Stable id of the signer device (derived from its public key). */
  readonly deviceId: string;
  readonly publicKeyHex: PublicKeyHex;
  /** Sign a message, returning a hex-encoded Ed25519 signature. */
  sign(message: Uint8Array): Promise<string>;
}

export interface KeyVault {
  /**
   * Return the device signing key, creating and persisting a new Ed25519 key
   * pair on first use. Idempotent.
   */
  getOrCreateSigningKey(): Promise<SigningKey>;
}

/** Raw 32-byte public key (hex) from a Node Ed25519 public KeyObject. */
export function publicKeyHexFrom(pub: KeyObject): PublicKeyHex {
  const der = pub.export({ type: "spki", format: "der" });
  // SPKI Ed25519 has a fixed 12-byte prefix followed by the 32-byte key.
  const raw = der.subarray(der.length - 32);
  return raw.toString("hex") as PublicKeyHex;
}

/**
 * Derive a stable, opaque device id from a public key. Not reversible to the
 * key; used purely as a signer label in envelopes and the trust registry.
 */
export function deviceIdFromPublicKey(publicKeyHex: PublicKeyHex): string {
  return `dev_${publicKeyHex.slice(0, 32)}`;
}

/**
 * In-memory vault for tests. Holds a generated (or injected) Ed25519 key pair
 * only in memory. Signing uses Node crypto directly. The private KeyObject is
 * closed over and never exposed.
 */
export class InMemoryVault implements KeyVault {
  private cached: SigningKey | null = null;

  constructor(private readonly seed?: { privateKeyPem: string }) {}

  async getOrCreateSigningKey(): Promise<SigningKey> {
    if (this.cached) return this.cached;
    const priv: KeyObject = this.seed
      ? createPrivateKey(this.seed.privateKeyPem)
      : generateKeyPairSync("ed25519").privateKey;
    const pub = createPublicKey(priv);
    const publicKeyHex = publicKeyHexFrom(pub);
    const deviceId = deviceIdFromPublicKey(publicKeyHex);
    this.cached = {
      deviceId,
      publicKeyHex,
      sign: async (message: Uint8Array): Promise<string> =>
        edSign(null, message, priv).toString("hex"),
    };
    return this.cached;
  }
}
