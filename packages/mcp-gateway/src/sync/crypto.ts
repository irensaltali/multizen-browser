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
 * Construction:
 *   - KDF: one of two, named by a discriminant in the header so an envelope
 *     describes how to re-derive its own key.
 *       · `scrypt` (Node built-in, synchronous) with N=2^15, r=8, p=1 — the
 *         default, used for config payloads keyed by the operator's existing
 *         encryption password.
 *       · `argon2id` (RFC 9106, via hash-wasm) with m=64 MiB, t=3, p=1 — used
 *         for the credential bundle, which is keyed by a *separate* passphrase
 *         and therefore wants the strongest memory-hard KDF available. Argon2id
 *         is only reachable through {@link sealAsync} / {@link openAsync}
 *         because the implementation is asynchronous.
 *     In both cases the salt is stored in the (authenticated, cleartext) header
 *     so a fresh device can re-derive the same key from the same password.
 *   - AEAD: AES-256-GCM with a 12-byte random nonce per message and a 16-byte
 *     tag. The nonce is stored in the header. Nonce reuse under one key is
 *     avoided by using a fresh CSPRNG nonce for every seal.
 *   - AAD: the canonical bytes of the envelope header (version, kdf params,
 *     salt, nonce, and an application `context` string). Binding the header as
 *     AAD means an attacker cannot swap headers or downgrade params without
 *     invalidating the tag.
 *
 * The wire format is a self-describing, versioned JSON header + base64 payload.
 * There is no custom or unauthenticated crypto anywhere in this file: both KDFs
 * and the AEAD are standard primitives from audited implementations.
 *
 * Because the header is attacker-supplied on read, KDF cost parameters are
 * bounded before they are used. An unbounded `memoryKib` would let anyone with
 * write access to the bucket turn a read into an out-of-memory crash.
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
export interface ScryptKdfParams {
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

/**
 * Argon2id (RFC 9106) cost parameters. Reachable only via the async seal/open
 * pair — the WebAssembly implementation has no synchronous entry point.
 */
export interface Argon2idKdfParams {
  readonly algorithm: "argon2id";
  /** Memory cost in kibibytes. */
  readonly memoryKib: number;
  /** Passes over memory (`t`). */
  readonly iterations: number;
  /** Lanes (`p`). Affects the output, not just threading, so it must match. */
  readonly parallelism: number;
  /** Derived key length in bytes (32 for AES-256). */
  readonly keyLenBytes: number;
}

/**
 * A KDF description, discriminated by `algorithm`. New algorithms are added
 * here rather than by adding a second envelope format.
 */
export type KdfParams = ScryptKdfParams | Argon2idKdfParams;

export const DEFAULT_KDF: ScryptKdfParams = {
  algorithm: "scrypt",
  n: 1 << 15,
  r: 8,
  p: 1,
  keyLenBytes: 32,
};

/**
 * Argon2id parameters for passphrase-derived keys.
 *
 * m=64 MiB / t=3 is RFC 9106's second recommended configuration. `p` is 1
 * rather than the RFC's 4 because hash-wasm is single-threaded: raising lanes
 * would not speed *us* up while still widening the parallelism available to an
 * attacker with real hardware. Measured at ~100 ms per derivation, which is an
 * acceptable cost for an operation that happens on unseal, not per request.
 */
export const DEFAULT_ARGON2ID_KDF: Argon2idKdfParams = {
  algorithm: "argon2id",
  memoryKib: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  keyLenBytes: 32,
};

/**
 * Upper bounds on attacker-supplied Argon2id cost. A header is untrusted input
 * read from the object store; without a ceiling, `memoryKib: 1 << 30` turns any
 * read attempt into an out-of-memory kill. 1 GiB is far above anything we emit
 * (64 MiB) and far below a denial of service.
 */
export const MAX_ARGON2ID_MEMORY_KIB = 1024 * 1024;
export const MAX_ARGON2ID_ITERATIONS = 16;
export const MAX_ARGON2ID_PARALLELISM = 16;

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

/**
 * The canonical JSON shape of a KDF description — the single definition used
 * both for the AEAD's additional data here and for record canonicalization by
 * callers, so a record's stored bytes and its verified AAD can never disagree.
 *
 * The scrypt branch emits exactly the fields it always has, so envelopes written
 * before Argon2id existed still canonicalize to identical bytes.
 */
export function kdfJson(kdf: KdfParams): JsonValue {
  if (kdf.algorithm === "argon2id") {
    return {
      algorithm: kdf.algorithm,
      memoryKib: kdf.memoryKib,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      keyLenBytes: kdf.keyLenBytes,
    };
  }
  return {
    algorithm: kdf.algorithm,
    n: kdf.n,
    r: kdf.r,
    p: kdf.p,
    keyLenBytes: kdf.keyLenBytes,
  };
}

function saltBytes(saltHex: string): Buffer {
  const salt = Buffer.from(saltHex, "hex");
  if (salt.length !== 32) {
    throw new CryptoError("salt must be 32 bytes", "params");
  }
  return salt;
}

function deriveScryptKey(password: string, saltHex: string, kdf: ScryptKdfParams): Buffer {
  assertPowerOfTwo(kdf.n);
  if (kdf.keyLenBytes !== 32) {
    throw new CryptoError("keyLenBytes must be 32 for AES-256", "params");
  }
  const salt = saltBytes(saltHex);
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

/**
 * Lazily loaded so the ~1.7 MB WebAssembly module is not paid for by the
 * scrypt-only config-sync path, which is by far the hotter one.
 */
let argon2idFn: Promise<typeof import("hash-wasm").argon2id> | null = null;
function loadArgon2id(): Promise<typeof import("hash-wasm").argon2id> {
  argon2idFn ??= import("hash-wasm").then((m) => m.argon2id);
  return argon2idFn;
}

async function deriveArgon2idKey(
  password: string,
  saltHex: string,
  kdf: Argon2idKdfParams,
): Promise<Buffer> {
  if (kdf.keyLenBytes !== 32) {
    throw new CryptoError("keyLenBytes must be 32 for AES-256", "params");
  }
  if (!Number.isInteger(kdf.parallelism) || kdf.parallelism < 1) {
    throw new CryptoError(`argon2id parallelism must be >= 1, got ${kdf.parallelism}`, "params");
  }
  if (kdf.parallelism > MAX_ARGON2ID_PARALLELISM) {
    throw new CryptoError(
      `argon2id parallelism ${kdf.parallelism} exceeds cap ${MAX_ARGON2ID_PARALLELISM}`,
      "params",
    );
  }
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 1) {
    throw new CryptoError(`argon2id iterations must be >= 1, got ${kdf.iterations}`, "params");
  }
  if (kdf.iterations > MAX_ARGON2ID_ITERATIONS) {
    throw new CryptoError(
      `argon2id iterations ${kdf.iterations} exceeds cap ${MAX_ARGON2ID_ITERATIONS}`,
      "params",
    );
  }
  // RFC 9106 requires m >= 8p; below that the algorithm is undefined.
  if (!Number.isInteger(kdf.memoryKib) || kdf.memoryKib < 8 * kdf.parallelism) {
    throw new CryptoError(
      `argon2id memoryKib must be an integer >= 8*parallelism, got ${kdf.memoryKib}`,
      "params",
    );
  }
  if (kdf.memoryKib > MAX_ARGON2ID_MEMORY_KIB) {
    throw new CryptoError(
      `argon2id memoryKib ${kdf.memoryKib} exceeds cap ${MAX_ARGON2ID_MEMORY_KIB}`,
      "params",
    );
  }
  const salt = saltBytes(saltHex);
  try {
    const argon2id = await loadArgon2id();
    const raw = await argon2id({
      password: Buffer.from(password, "utf8"),
      salt,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      memorySize: kdf.memoryKib,
      hashLength: kdf.keyLenBytes,
      outputType: "binary",
    });
    // `outputType: "binary"` is documented to return a Uint8Array; assert it so
    // a library change cannot silently hand us a hex string to use as a key.
    if (!(raw instanceof Uint8Array) || raw.length !== kdf.keyLenBytes) {
      throw new Error("argon2id returned unexpected output");
    }
    return Buffer.from(raw);
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError(`argon2id derivation failed: ${(err as Error).message}`, "kdf");
  }
}

function deriveKey(password: string, saltHex: string, kdf: KdfParams): Buffer {
  if (kdf.algorithm === "argon2id") {
    throw new CryptoError(
      "argon2id is asynchronous; use sealAsync/openAsync instead of seal/open",
      "params",
    );
  }
  if (kdf.algorithm !== "scrypt") {
    throw new CryptoError(`Unsupported KDF ${String((kdf as KdfParams).algorithm)}`, "params");
  }
  return deriveScryptKey(password, saltHex, kdf);
}

async function deriveKeyAsync(
  password: string,
  saltHex: string,
  kdf: KdfParams,
): Promise<Buffer> {
  if (kdf.algorithm === "argon2id") return deriveArgon2idKey(password, saltHex, kdf);
  if (kdf.algorithm === "scrypt") return deriveScryptKey(password, saltHex, kdf);
  throw new CryptoError(`Unsupported KDF ${String((kdf as KdfParams).algorithm)}`, "params");
}

function headerAad(header: EnvelopeHeader): Uint8Array {
  // The AAD is the canonical bytes of the full header. Any header mutation
  // (version/params/salt/nonce/context) invalidates the GCM tag.
  const json: JsonValue = {
    v: header.v,
    alg: header.alg,
    kdf: kdfJson(header.kdf),
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
 *
 * Synchronous, and therefore scrypt-only. Passing Argon2id params throws
 * `params`; use {@link sealAsync}.
 */
export function seal(
  password: string,
  plaintext: Uint8Array,
  options: SealOptions,
): CryptoEnvelope {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const key = deriveKey(password, options.saltHex, kdf);
  try {
    return encryptWithKey(key, plaintext, kdf, options);
  } finally {
    key.fill(0);
  }
}

/**
 * {@link seal} for any supported KDF, including Argon2id. Identical wire format;
 * the only difference is that key derivation may be asynchronous.
 */
export async function sealAsync(
  password: string,
  plaintext: Uint8Array,
  options: SealOptions,
): Promise<CryptoEnvelope> {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const key = await deriveKeyAsync(password, options.saltHex, kdf);
  try {
    return encryptWithKey(key, plaintext, kdf, options);
  } finally {
    key.fill(0);
  }
}

/**
 * The AEAD half of sealing, shared by the sync and async entry points so there
 * is exactly one place that builds a header and one place that encrypts.
 */
function encryptWithKey(
  key: Buffer,
  plaintext: Uint8Array,
  kdf: KdfParams,
  options: SealOptions,
): CryptoEnvelope {
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
}

function validateKdf(raw: unknown): KdfParams {
  if (typeof raw !== "object" || raw === null) {
    throw new CryptoError("invalid kdf", "malformed");
  }
  const k = raw as Record<string, unknown>;
  const intField = (field: string): number => {
    const v = k[field];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new CryptoError(`invalid kdf.${field}`, "malformed");
    }
    return v;
  };
  if (k.algorithm === "scrypt") {
    return {
      algorithm: "scrypt",
      n: intField("n"),
      r: intField("r"),
      p: intField("p"),
      keyLenBytes: intField("keyLenBytes"),
    };
  }
  if (k.algorithm === "argon2id") {
    return {
      algorithm: "argon2id",
      memoryKib: intField("memoryKib"),
      iterations: intField("iterations"),
      parallelism: intField("parallelism"),
      keyLenBytes: intField("keyLenBytes"),
    };
  }
  throw new CryptoError("unsupported kdf algorithm", "malformed");
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
  return {
    v: CRYPTO_ENVELOPE_VERSION,
    alg: "AES-256-GCM",
    kdf: validateKdf(h.kdf),
    saltHex: h.saltHex,
    nonceHex: h.nonceHex,
    context: h.context,
  };
}

/**
 * Validate an envelope down to the point where only key derivation is left.
 * Shared by {@link open} and {@link openAsync} so both apply exactly the same
 * checks in the same order.
 */
function prepareOpen(
  envelope: CryptoEnvelope,
  expectedContext?: string,
): { header: EnvelopeHeader; tag: Buffer } {
  const header = validateHeader(envelope.header);
  if (expectedContext !== undefined && header.context !== expectedContext) {
    throw new CryptoError("envelope context mismatch", "auth");
  }
  const tag = Buffer.from(envelope.tag, "base64");
  if (tag.length !== 16) {
    throw new CryptoError("auth tag must be 16 bytes", "malformed");
  }
  return { header, tag };
}

function decryptWithKey(
  key: Buffer,
  envelope: CryptoEnvelope,
  header: EnvelopeHeader,
  tag: Buffer,
): Uint8Array {
  const nonce = Buffer.from(header.nonceHex, "hex");
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
}

/**
 * Decrypt and verify an envelope. Throws {@link CryptoError} with code `auth`
 * on ANY authentication failure (wrong password, tampered ciphertext/tag/header,
 * context mismatch). Never returns partially-decrypted data.
 *
 * `expectedContext`, when provided, must equal the header context; this binds
 * the ciphertext to its intended logical slot (defense against record
 * substitution even by a password holder).
 *
 * Synchronous, and therefore scrypt-only. An Argon2id envelope throws `params`;
 * use {@link openAsync}.
 */
export function open(
  password: string,
  envelope: CryptoEnvelope,
  expectedContext?: string,
): Uint8Array {
  const { header, tag } = prepareOpen(envelope, expectedContext);
  const key = deriveKey(password, header.saltHex, header.kdf);
  try {
    return decryptWithKey(key, envelope, header, tag);
  } finally {
    key.fill(0);
  }
}

/**
 * {@link open} for any supported KDF, including Argon2id. Identical checks and
 * identical failure codes; only key derivation may be asynchronous.
 */
export async function openAsync(
  password: string,
  envelope: CryptoEnvelope,
  expectedContext?: string,
): Promise<Uint8Array> {
  const { header, tag } = prepareOpen(envelope, expectedContext);
  const key = await deriveKeyAsync(password, header.saltHex, header.kdf);
  try {
    return decryptWithKey(key, envelope, header, tag);
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
