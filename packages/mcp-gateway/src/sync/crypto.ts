/**
 * Authenticated encryption envelope for project-config payloads at rest.
 *
 * Threat model: the object store (R2/S3) is treated as an *untrusted* medium. A
 * project payload placed there must be confidential (an attacker with read
 * access learns nothing about the config) and tamper-evident (any bit-flip,
 * truncation, or record substitution fails to decrypt). We therefore wrap every
 * payload in an AES-256-GCM envelope keyed by a per-repository key that is
 * *derived on demand* from the operator's existing encryption password and a
 * per-repository random salt. The password and derived key are NEVER written to
 * the store, a log, or any config; the key lives only in memory for the lifetime
 * of the calling operation.
 *
 * Construction (all Node `crypto`, no third-party dependency):
 *   - KDF: scrypt(password, salt=32B random, N=2^15, r=8, p=1) → 32-byte key.
 *     The salt is stored in the (authenticated, cleartext) envelope header so a
 *     fresh device can re-derive the same key from the same password.
 *   - AEAD: AES-256-GCM with a 12-byte random nonce per message and a 16-byte
 *     tag. The nonce is stored in the header. Nonce reuse under one key is
 *     avoided by using a fresh CSPRNG nonce for every seal.
 *   - AAD: the canonical bytes of the envelope header (version, kdf params,
 *     salt, nonce, and an application `context` string). Binding the header as
 *     AAD means an attacker cannot swap headers or downgrade params without
 *     invalidating the tag.
 *
 * The wire format is a self-describing, versioned JSON header + base64 payload.
 * There is no custom or unauthenticated crypto anywhere in this file.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { canonicalBytes, type JsonValue } from "../canonicalJson.js";

export const CRYPTO_ENVELOPE_VERSION = 1 as const;

/** scrypt cost parameters. Kept in the header so they can evolve per envelope. */
export interface KdfParams {
  readonly algorithm: "scrypt";
  /** CPU/memory cost (must be a power of two). */
  readonly n: number;
  /** Block size. */
  readonly r: number;
  /** Parallelization. */
  readonly p: number;
  /** Derived key length in bytes (32 for AES-256). */
  readonly keyLenBytes: number;
}

export const DEFAULT_KDF: KdfParams = {
  algorithm: "scrypt",
  n: 1 << 15,
  r: 8,
  p: 1,
  keyLenBytes: 32,
};

/**
 * scrypt with n=2^15,r=8,p=1 needs ~128 * N * r bytes ≈ 32 MiB of memory. Node's
 * default maxmem (32 MiB) is exactly at the edge and can spuriously throw, so we
 * pass an explicit, comfortable ceiling.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface EnvelopeHeader {
  readonly v: typeof CRYPTO_ENVELOPE_VERSION;
  readonly alg: "AES-256-GCM";
  readonly kdf: KdfParams;
  /** Hex salt for key derivation (per repository, stable across a repo). */
  readonly saltHex: string;
  /** Hex GCM nonce (per message, unique). */
  readonly nonceHex: string;
  /**
   * Application binding string mixed into the AAD (e.g. a project id). Prevents
   * an authenticated ciphertext from being replayed under a different logical
   * slot even by someone who knows the password.
   */
  readonly context: string;
}

/** The on-the-wire envelope: authenticated header + ciphertext + tag. */
export interface CryptoEnvelope {
  readonly header: EnvelopeHeader;
  /** base64 ciphertext. */
  readonly ciphertext: string;
  /** base64 GCM auth tag (16 bytes). */
  readonly tag: string;
}

export class CryptoError extends Error {
  override readonly name = "CryptoError";
  constructor(
    message: string,
    readonly code: "kdf" | "auth" | "malformed" | "params",
  ) {
    super(message);
  }
}

function assertPowerOfTwo(n: number): void {
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
    throw new CryptoError(`scrypt N must be a power of two >= 2, got ${n}`, "params");
  }
}

/**
 * A per-repository salt. Generate once when a repository is first initialized,
 * persist it (it is not secret) alongside the encrypted objects, and reuse it so
 * every device derives the identical key from the same password.
 */
export function generateSaltHex(): string {
  return randomBytes(32).toString("hex");
}

function deriveKey(password: string, saltHex: string, kdf: KdfParams): Buffer {
  if (kdf.algorithm !== "scrypt") {
    throw new CryptoError(`Unsupported KDF ${String(kdf.algorithm)}`, "params");
  }
  assertPowerOfTwo(kdf.n);
  if (kdf.keyLenBytes !== 32) {
    throw new CryptoError("keyLenBytes must be 32 for AES-256", "params");
  }
  const salt = Buffer.from(saltHex, "hex");
  if (salt.length !== 32) {
    throw new CryptoError("salt must be 32 bytes", "params");
  }
  try {
    return scryptSync(Buffer.from(password, "utf8"), salt, kdf.keyLenBytes, {
      N: kdf.n,
      r: kdf.r,
      p: kdf.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch (err) {
    throw new CryptoError(`scrypt derivation failed: ${(err as Error).message}`, "kdf");
  }
}

function headerAad(header: EnvelopeHeader): Uint8Array {
  // The AAD is the canonical bytes of the full header. Any header mutation
  // (version/params/salt/nonce/context) invalidates the GCM tag.
  const json: JsonValue = {
    v: header.v,
    alg: header.alg,
    kdf: {
      algorithm: header.kdf.algorithm,
      n: header.kdf.n,
      r: header.kdf.r,
      p: header.kdf.p,
      keyLenBytes: header.kdf.keyLenBytes,
    },
    saltHex: header.saltHex,
    nonceHex: header.nonceHex,
    context: header.context,
  };
  return canonicalBytes(json);
}

export interface SealOptions {
  /** Per-repository salt (hex). Reuse the same salt across a repository. */
  readonly saltHex: string;
  /** Application binding string mixed into AAD (e.g. project id). */
  readonly context: string;
  /** Override KDF params (defaults to {@link DEFAULT_KDF}). */
  readonly kdf?: KdfParams;
}

/**
 * Encrypt-and-authenticate `plaintext` into a self-describing envelope. A fresh
 * random nonce is used for every call. The password/derived key are used only
 * transiently and never returned.
 */
export function seal(
  password: string,
  plaintext: Uint8Array,
  options: SealOptions,
): CryptoEnvelope {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const key = deriveKey(password, options.saltHex, kdf);
  try {
    const nonce = randomBytes(12);
    const header: EnvelopeHeader = {
      v: CRYPTO_ENVELOPE_VERSION,
      alg: "AES-256-GCM",
      kdf,
      saltHex: options.saltHex,
      nonceHex: nonce.toString("hex"),
      context: options.context,
    };
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(headerAad(header)));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      header,
      ciphertext: ct.toString("base64"),
      tag: tag.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

function validateHeader(header: unknown): EnvelopeHeader {
  if (typeof header !== "object" || header === null) {
    throw new CryptoError("envelope header must be an object", "malformed");
  }
  const h = header as Record<string, unknown>;
  if (h.v !== CRYPTO_ENVELOPE_VERSION) {
    throw new CryptoError(`unsupported envelope version ${String(h.v)}`, "malformed");
  }
  if (h.alg !== "AES-256-GCM") {
    throw new CryptoError(`unsupported alg ${String(h.alg)}`, "malformed");
  }
  if (typeof h.saltHex !== "string" || !/^[0-9a-f]{64}$/.test(h.saltHex)) {
    throw new CryptoError("invalid saltHex", "malformed");
  }
  if (typeof h.nonceHex !== "string" || !/^[0-9a-f]{24}$/.test(h.nonceHex)) {
    throw new CryptoError("invalid nonceHex", "malformed");
  }
  if (typeof h.context !== "string") {
    throw new CryptoError("invalid context", "malformed");
  }
  const kdfRaw = h.kdf;
  if (typeof kdfRaw !== "object" || kdfRaw === null) {
    throw new CryptoError("invalid kdf", "malformed");
  }
  const k = kdfRaw as Record<string, unknown>;
  if (k.algorithm !== "scrypt") {
    throw new CryptoError("unsupported kdf algorithm", "malformed");
  }
  for (const field of ["n", "r", "p", "keyLenBytes"] as const) {
    if (typeof k[field] !== "number" || !Number.isInteger(k[field] as number)) {
      throw new CryptoError(`invalid kdf.${field}`, "malformed");
    }
  }
  const kdf: KdfParams = {
    algorithm: "scrypt",
    n: k.n as number,
    r: k.r as number,
    p: k.p as number,
    keyLenBytes: k.keyLenBytes as number,
  };
  return {
    v: CRYPTO_ENVELOPE_VERSION,
    alg: "AES-256-GCM",
    kdf,
    saltHex: h.saltHex,
    nonceHex: h.nonceHex,
    context: h.context,
  };
}

/**
 * Decrypt and verify an envelope. Throws {@link CryptoError} with code `auth`
 * on ANY authentication failure (wrong password, tampered ciphertext/tag/header,
 * context mismatch). Never returns partially-decrypted data.
 *
 * `expectedContext`, when provided, must equal the header context; this binds
 * the ciphertext to its intended logical slot (defense against record
 * substitution even by a password holder).
 */
export function open(
  password: string,
  envelope: CryptoEnvelope,
  expectedContext?: string,
): Uint8Array {
  const header = validateHeader(envelope.header);
  if (expectedContext !== undefined && header.context !== expectedContext) {
    throw new CryptoError("envelope context mismatch", "auth");
  }
  const tag = Buffer.from(envelope.tag, "base64");
  if (tag.length !== 16) {
    throw new CryptoError("auth tag must be 16 bytes", "malformed");
  }
  const nonce = Buffer.from(header.nonceHex, "hex");
  const key = deriveKey(password, header.saltHex, header.kdf);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(headerAad(header)));
    decipher.setAuthTag(tag);
    const ct = Buffer.from(envelope.ciphertext, "base64");
    try {
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return new Uint8Array(pt);
    } catch {
      // GCM tag verification failed: wrong key or tampered data.
      throw new CryptoError("authentication failed (wrong password or tampered data)", "auth");
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Constant-time comparison of two byte arrays. Exposed for callers that need to
 * compare authentication-sensitive material without a timing side channel.
 */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
