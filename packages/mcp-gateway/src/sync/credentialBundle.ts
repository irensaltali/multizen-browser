/**
 * The credential bundle: named secrets sealed under a passphrase that is
 * SEPARATE from the repository encryption password.
 *
 * Everything else MultiZen syncs is encrypted with the operator's existing
 * encryption password, because everything else is configuration. Credentials are
 * different in kind: they are the thing configuration *refers to*, and the cost
 * of getting them wrong is not "a project looks odd on the other laptop", it is
 * "someone else's upstream API keys are now theirs". So the bundle is protected
 * by a second factor the operator supplies explicitly:
 *
 *   - Outer layer (provided by {@link SyncedDocumentStore}): AES-256-GCM under
 *     the repository password, an Ed25519 signature checked against the trust
 *     registry, monotonic revisions, and compare-and-swap. Identical to every
 *     other synced document — a bundle is not a special case on the wire.
 *   - Inner layer (this module): AES-256-GCM under a key derived from the
 *     bundle passphrase with Argon2id. Unwrapping the outer layer yields only
 *     another ciphertext.
 *
 * The consequence is the property that matters: holding the bucket credentials
 * AND the repository password is still not enough to read a single secret. An
 * attacker needs the passphrase, which never leaves the operator's head, is
 * never written to settings, and never crosses IPC in a readable direction.
 *
 * What is deliberately NOT in the cleartext: the number of entries, their names,
 * and when the bundle was sealed. All of it lives inside the sealed payload.
 * Putting a count or a timestamp in the clear would be convenient for the UI,
 * but anything outside the AEAD is attacker-writable, and unauthenticated
 * metadata that some later code path trusts is how this kind of design fails.
 * The only cleartext is the format version, which the AEAD's own header
 * duplicates in authenticated form.
 *
 * What may be bundled is decided here, not by the caller. {@link sealCredentialBundle}
 * re-checks every entry it is handed and {@link openCredentialBundle} re-checks
 * every entry it recovers, so neither a collector bug nor a hostile-but-trusted
 * writer can get an excluded secret into or out of a bundle. The exclusions are
 * not stylistic: the S3 keys and the repository password are what *guard* the
 * bucket, and the device signing key is what makes this device a distinct
 * identity. Backing any of them up into the bucket they protect would collapse
 * the layering — one compromise would yield everything, and a restored signing
 * key would let two machines impersonate each other.
 */

import { canonicalize, type JsonValue } from "../canonicalJson.js";
import { isEnvName, isSafeId } from "../ids.js";
import {
  CryptoError,
  DEFAULT_ARGON2ID_KDF,
  generateSaltHex,
  kdfJson,
  openAsync,
  sealAsync,
  type Argon2idKdfParams,
  type CryptoEnvelope,
} from "./crypto.js";

export const CREDENTIAL_BUNDLE_VERSION = 1 as const;

/**
 * AEAD context string for the inner envelope. Binds the ciphertext to "this is a
 * credential bundle", so an Argon2id envelope produced for some other purpose
 * cannot be substituted in, even by someone who knows the passphrase.
 */
export const CREDENTIAL_BUNDLE_CONTEXT = "credential-bundle:v1";

/**
 * Cap on the sealed plaintext. The enclosing document is capped at 1 MiB and
 * base64 inflates by 4/3, so 256 KiB of secrets leaves ample headroom while
 * still bounding how much a malformed record can make us allocate.
 */
export const MAX_CREDENTIAL_BUNDLE_BYTES = 256 * 1024;

/** Longest accepted credential name. Bounds a pathological bundle's shape. */
export const MAX_CREDENTIAL_NAME_LENGTH = 256;

/**
 * Floor on passphrase length. This is a backstop against a caller that skips the
 * UI's strength check, not a substitute for it — a 12-character passphrase is
 * the minimum this code will accept, not a recommendation.
 */
export const MIN_BUNDLE_PASSPHRASE_LENGTH = 12;

/**
 * The only credential-name prefixes eligible for the bundle. Default deny: a new
 * kind of secret is excluded until someone adds it here on purpose.
 *
 * - `project-secret:` — values the operator pasted in (upstream API keys and the
 *   like). Unrecoverable by any other means; the whole point of the feature.
 * - `project-token:` — per-project bearer tokens for the gateway's local auth.
 *   A restored device could mint its own, but the one-shot reveal exists so the
 *   operator can paste a token into external agent configs by hand, and silently
 *   changing it on restore would break those without saying so.
 */
export const CREDENTIAL_SECRET_PREFIX = "mcp-gateway:project-secret:";
export const CREDENTIAL_TOKEN_PREFIX = "mcp-gateway:project-token:";

export const BUNDLEABLE_CREDENTIAL_PREFIXES: readonly string[] = [
  CREDENTIAL_SECRET_PREFIX,
  CREDENTIAL_TOKEN_PREFIX,
];

/**
 * Credential names that must never be bundled regardless of anything else.
 *
 * The sync-config credential refs (Kopia password, S3 key id, S3 secret) are NOT
 * listed here because their names are operator-configurable strings in settings:
 * callers pass the configured names in as `excludedNames`. This list holds only
 * the names this package fixes itself.
 */
export const NEVER_BUNDLED_CREDENTIAL_NAMES: readonly string[] = [
  // Reconstructible device identity would let a restored machine sign as the
  // machine it was restored from.
  "mcp-gateway:device-signing-key-pem",
  // Not secret, but device-scoped and already carried in envelope headers;
  // round-tripping it through a bundle serves no purpose.
  "mcp-gateway:sync-salt-hex",
  // The passphrase that protects the bundle. Sealing it inside the thing it
  // protects would reduce the second factor to the first one.
  "mcp-gateway:credential-bundle-passphrase",
];

/**
 * The project a bundleable credential belongs to, or null when the name does not
 * name a project credential at all.
 *
 * Safe to parse by splitting on `:` because both halves have restricted
 * grammars: a project id is `[a-z0-9_-]` and an env reference NAME is
 * `[A-Za-z_][A-Za-z0-9_]*`, so neither can contain a separator.
 *
 * Used to decide whose secrets a given device is entitled to speak for: a device
 * that does not have a project must not be able to drop that project's secrets
 * from the shared backup.
 */
export function credentialProjectId(name: string): string | null {
  if (name.startsWith(CREDENTIAL_TOKEN_PREFIX)) {
    const id = name.slice(CREDENTIAL_TOKEN_PREFIX.length);
    return isSafeId(id) ? id : null;
  }
  if (name.startsWith(CREDENTIAL_SECRET_PREFIX)) {
    const rest = name.slice(CREDENTIAL_SECRET_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return null;
    const id = rest.slice(0, sep);
    const envName = rest.slice(sep + 1);
    return isSafeId(id) && isEnvName(envName) ? id : null;
  }
  return null;
}

export type CredentialBundleErrorCode =
  /** Name does not match any bundleable prefix (default-deny inclusion check). */
  | "not-bundleable"
  /** Name is on an exclusion list (explicit deny, checked independently). */
  | "excluded"
  | "duplicate"
  | "invalid-entry"
  | "too-large"
  | "weak-passphrase"
  | "malformed"
  | "auth";

export class CredentialBundleError extends Error {
  override readonly name = "CredentialBundleError";
  constructor(
    message: string,
    readonly code: CredentialBundleErrorCode,
  ) {
    super(message);
  }
}

/** One named secret: a vault credential name and its value. */
export interface CredentialEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * A sealed bundle, safe to publish as the value of a synced document. Carries no
 * cleartext beyond its format version.
 */
export interface CredentialBundle {
  readonly bundleVersion: typeof CREDENTIAL_BUNDLE_VERSION;
  /** Argon2id + AES-256-GCM envelope over the canonical bundle payload. */
  readonly sealed: CryptoEnvelope;
}

/** The recovered contents of a bundle. */
export interface OpenedCredentialBundle {
  readonly bundleVersion: typeof CREDENTIAL_BUNDLE_VERSION;
  /** Authenticated seal time (ms since epoch) — from inside the AEAD. */
  readonly sealedAt: number;
  readonly entries: readonly CredentialEntry[];
}

/** Names the caller's configuration reserves for secrets that must not sync. */
export interface BundleScope {
  /**
   * Additional names to refuse, beyond {@link NEVER_BUNDLED_CREDENTIAL_NAMES}.
   * Callers pass the sync config's credential refs so a bucket credential can
   * never be backed up into that bucket even if it were renamed to look
   * bundleable.
   */
  readonly excludedNames?: readonly string[];
}

/** True when a credential name matches the inclusion allowlist. */
export function isBundleableCredentialName(name: string): boolean {
  return BUNDLEABLE_CREDENTIAL_PREFIXES.some(
    (prefix) => name.startsWith(prefix) && name.length > prefix.length,
  );
}

/**
 * Throw when `name` is explicitly excluded. Kept separate from the inclusion
 * check so it is independently reachable: the two defences overlap for most
 * inputs, and a single combined check would let one of them rot unnoticed.
 */
export function assertNotExcluded(name: string, scope: BundleScope = {}): void {
  if (NEVER_BUNDLED_CREDENTIAL_NAMES.includes(name)) {
    throw new CredentialBundleError(
      `credential ${name} is never included in a bundle`,
      "excluded",
    );
  }
  if (scope.excludedNames?.includes(name) === true) {
    throw new CredentialBundleError(
      `credential ${name} is excluded by configuration`,
      "excluded",
    );
  }
}

/** Throw unless `name` is both allowlisted and not excluded. */
export function assertBundleable(name: string, scope: BundleScope = {}): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new CredentialBundleError("credential name must be a non-empty string", "invalid-entry");
  }
  if (name.length > MAX_CREDENTIAL_NAME_LENGTH) {
    throw new CredentialBundleError(
      `credential name exceeds ${MAX_CREDENTIAL_NAME_LENGTH} characters`,
      "invalid-entry",
    );
  }
  // Exclusions are checked FIRST so an excluded name reports `excluded` even
  // when it would also have failed the inclusion test. Reporting the specific
  // reason is what keeps both checks honest under test.
  assertNotExcluded(name, scope);
  if (!isBundleableCredentialName(name)) {
    throw new CredentialBundleError(
      `credential ${name} is not eligible for a bundle`,
      "not-bundleable",
    );
  }
}

/**
 * Filter a full list of vault names down to those a bundle may contain. Silent
 * by design: a vault legitimately holds secrets that are not bundleable, so
 * skipping them is normal, not an error.
 */
export function selectBundleableNames(
  all: readonly string[],
  scope: BundleScope = {},
): string[] {
  return all
    .filter((name) => {
      try {
        assertBundleable(name, scope);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

interface BundlePayloadShape {
  readonly bundleVersion: typeof CREDENTIAL_BUNDLE_VERSION;
  readonly sealedAt: number;
  readonly entries: readonly { readonly name: string; readonly value: string }[];
}

function payloadJson(payload: BundlePayloadShape): JsonValue {
  return {
    bundleVersion: payload.bundleVersion,
    sealedAt: payload.sealedAt,
    entries: payload.entries.map((e) => ({ name: e.name, value: e.value })),
  };
}

function validateEntries(
  entries: readonly CredentialEntry[],
  scope: BundleScope,
): CredentialEntry[] {
  const seen = new Set<string>();
  const out: CredentialEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new CredentialBundleError("bundle entry must be an object", "invalid-entry");
    }
    if (typeof entry.value !== "string") {
      throw new CredentialBundleError(
        `credential ${String(entry.name)} has a non-string value`,
        "invalid-entry",
      );
    }
    assertBundleable(entry.name, scope);
    if (seen.has(entry.name)) {
      throw new CredentialBundleError(`duplicate credential ${entry.name}`, "duplicate");
    }
    seen.add(entry.name);
    out.push({ name: entry.name, value: entry.value });
  }
  // Sorted so two devices holding the same secrets seal identical plaintext,
  // which keeps the payload hash meaningful as a change signal.
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface SealBundleOptions extends BundleScope {
  /** Override the seal timestamp (tests). Defaults to `Date.now()`. */
  readonly now?: number;
  /** Override Argon2id cost (tests use a cheap profile). */
  readonly kdf?: Argon2idKdfParams;
}

/**
 * Seal `entries` under `passphrase`.
 *
 * A fresh random salt is generated per seal and stored in the envelope header,
 * so there is no bundle salt to persist, coordinate between devices, or get
 * wrong — a device that knows the passphrase can open any bundle it can read.
 */
export async function sealCredentialBundle(
  passphrase: string,
  entries: readonly CredentialEntry[],
  options: SealBundleOptions = {},
): Promise<CredentialBundle> {
  assertPassphraseAcceptable(passphrase);
  const checked = validateEntries(entries, options);
  const payload: BundlePayloadShape = {
    bundleVersion: CREDENTIAL_BUNDLE_VERSION,
    sealedAt: options.now ?? Date.now(),
    entries: checked,
  };
  const plaintext = new TextEncoder().encode(canonicalize(payloadJson(payload)));
  if (plaintext.byteLength > MAX_CREDENTIAL_BUNDLE_BYTES) {
    throw new CredentialBundleError(
      `bundle plaintext ${plaintext.byteLength} exceeds cap ${MAX_CREDENTIAL_BUNDLE_BYTES}`,
      "too-large",
    );
  }
  const sealed = await sealAsync(passphrase, plaintext, {
    saltHex: generateSaltHex(),
    context: CREDENTIAL_BUNDLE_CONTEXT,
    kdf: options.kdf ?? DEFAULT_ARGON2ID_KDF,
  });
  return { bundleVersion: CREDENTIAL_BUNDLE_VERSION, sealed };
}

/** Reject a passphrase this module will not seal under. */
export function assertPassphraseAcceptable(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MIN_BUNDLE_PASSPHRASE_LENGTH) {
    throw new CredentialBundleError(
      `bundle passphrase must be at least ${MIN_BUNDLE_PASSPHRASE_LENGTH} characters`,
      "weak-passphrase",
    );
  }
}

/**
 * Parse an untrusted value into a {@link CredentialBundle} without opening it.
 * Used by callers that need to know a bundle exists (and is structurally sound)
 * before asking the operator for a passphrase.
 */
export function parseCredentialBundle(value: unknown): CredentialBundle {
  if (typeof value !== "object" || value === null) {
    throw new CredentialBundleError("bundle must be an object", "malformed");
  }
  const v = value as Record<string, unknown>;
  if (v.bundleVersion !== CREDENTIAL_BUNDLE_VERSION) {
    throw new CredentialBundleError(
      `unsupported bundleVersion ${String(v.bundleVersion)}`,
      "malformed",
    );
  }
  const sealed = v.sealed;
  if (typeof sealed !== "object" || sealed === null) {
    throw new CredentialBundleError("bundle sealed payload must be an object", "malformed");
  }
  const s = sealed as Record<string, unknown>;
  if (typeof s.ciphertext !== "string" || typeof s.tag !== "string") {
    throw new CredentialBundleError("bundle sealed payload is incomplete", "malformed");
  }
  // A bundle is Argon2id or it is not a bundle. Refusing any other KDF here means
  // the format cannot be silently downgraded to a cheaper one — not by a hostile
  // writer, and not by a future caller that forgets to pass the right params.
  const header = s.header;
  if (typeof header !== "object" || header === null) {
    throw new CredentialBundleError("bundle envelope header must be an object", "malformed");
  }
  const kdf = (header as Record<string, unknown>).kdf;
  if (
    typeof kdf !== "object" ||
    kdf === null ||
    (kdf as Record<string, unknown>).algorithm !== "argon2id"
  ) {
    throw new CredentialBundleError("bundle must be sealed with argon2id", "malformed");
  }
  // Reject an oversized record before the ~100 ms key derivation, so a bogus
  // object cannot be used to burn CPU or force a large allocation.
  if (Buffer.from(s.ciphertext, "base64").byteLength > MAX_CREDENTIAL_BUNDLE_BYTES) {
    throw new CredentialBundleError("bundle ciphertext exceeds size cap", "too-large");
  }
  return { bundleVersion: CREDENTIAL_BUNDLE_VERSION, sealed: sealed as unknown as CryptoEnvelope };
}

/**
 * Open a bundle with `passphrase`.
 *
 * Throws `auth` for a wrong passphrase or any tampering, `malformed` for a
 * structurally invalid payload, and `excluded`/`not-bundleable` if the recovered
 * contents name a credential that may not be restored. The last case is the
 * important one: the outer document is signed by a *trusted* device, so without
 * re-checking here a compromised trusted device could hand this one a bundle
 * that overwrites its signing key.
 */
export async function openCredentialBundle(
  passphrase: string,
  bundle: unknown,
  scope: BundleScope = {},
): Promise<OpenedCredentialBundle> {
  const parsed = parseCredentialBundle(bundle);
  let plaintext: Uint8Array;
  try {
    plaintext = await openAsync(passphrase, parsed.sealed, CREDENTIAL_BUNDLE_CONTEXT);
  } catch (err) {
    // Distinguish "you typed the wrong passphrase" from "this record is bogus".
    // Collapsing both into `auth` would send an operator hunting for a typo when
    // the real problem is a corrupt or hostile object in the bucket.
    if (err instanceof CryptoError && (err.code === "malformed" || err.code === "params")) {
      throw new CredentialBundleError(`bundle envelope is invalid: ${err.message}`, "malformed");
    }
    throw new CredentialBundleError(
      `bundle could not be opened: ${(err as Error).message}`,
      "auth",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new CredentialBundleError("bundle payload is not valid JSON/UTF-8", "malformed");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new CredentialBundleError("bundle payload must be an object", "malformed");
  }
  const p = raw as Record<string, unknown>;
  if (p.bundleVersion !== CREDENTIAL_BUNDLE_VERSION) {
    throw new CredentialBundleError("bundle payload version mismatch", "malformed");
  }
  if (typeof p.sealedAt !== "number" || !Number.isFinite(p.sealedAt)) {
    throw new CredentialBundleError("bundle payload has no valid sealedAt", "malformed");
  }
  if (!Array.isArray(p.entries)) {
    throw new CredentialBundleError("bundle payload entries must be an array", "malformed");
  }
  // Re-run the same admission checks used on seal. A bundle arrives signed by a
  // trusted device, but "trusted" is not "incapable of being compromised".
  const entries = validateEntries(p.entries as CredentialEntry[], scope);
  return {
    bundleVersion: CREDENTIAL_BUNDLE_VERSION,
    sealedAt: p.sealedAt,
    entries,
  };
}

/**
 * The bundle as a plain JSON value, ready to be a synced document's payload.
 * Built field by field (not via a JSON round-trip) so the serialized shape is
 * explicit and the KDF params go through the same canonicalizer as every other
 * record in this package.
 */
export function credentialBundleToJson(bundle: CredentialBundle): JsonValue {
  const h = bundle.sealed.header;
  return {
    bundleVersion: bundle.bundleVersion,
    sealed: {
      header: {
        v: h.v,
        alg: h.alg,
        kdf: kdfJson(h.kdf),
        saltHex: h.saltHex,
        nonceHex: h.nonceHex,
        context: h.context,
      },
      ciphertext: bundle.sealed.ciphertext,
      tag: bundle.sealed.tag,
    },
  };
}

// ── the document that carries a bundle ───────────────────────────────────────

export const CREDENTIALS_DOCUMENT_VERSION = 1 as const;

/**
 * The value published as the `credentials` synced document.
 *
 * `bundle: null` is a meaningful state, not an absence: it is how switching the
 * feature off replaces the stored ciphertext. The alternative — deleting the
 * object — is not available (the conditional object store has no delete, by
 * design) and would also break the monotonic revision chain, since a recreated
 * object would start at revision 1 while peers still remember a higher one.
 *
 * Publishing a null bundle needs no passphrase. That is deliberate: an operator
 * who has forgotten the passphrase must still be able to stop backing up
 * credentials.
 */
export interface CredentialsDocument {
  readonly version: typeof CREDENTIALS_DOCUMENT_VERSION;
  readonly bundle: CredentialBundle | null;
}

/** Serialize a credentials document for publication. */
export function credentialsDocumentToJson(doc: CredentialsDocument): JsonValue {
  return {
    version: doc.version,
    bundle: doc.bundle === null ? null : credentialBundleToJson(doc.bundle),
  };
}

/**
 * Parse an untrusted credentials document. Distinguishes "there is no bundle
 * here" (a purge) from "this is not a credentials document" (throw), so a caller
 * never mistakes corruption for an intentional opt-out.
 */
export function parseCredentialsDocument(raw: unknown): CredentialsDocument {
  if (typeof raw !== "object" || raw === null) {
    throw new CredentialBundleError("credentials document must be an object", "malformed");
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== CREDENTIALS_DOCUMENT_VERSION) {
    throw new CredentialBundleError(
      `unsupported credentials document version ${String(r.version)}`,
      "malformed",
    );
  }
  if (r.bundle === null || r.bundle === undefined) {
    return { version: CREDENTIALS_DOCUMENT_VERSION, bundle: null };
  }
  return {
    version: CREDENTIALS_DOCUMENT_VERSION,
    bundle: parseCredentialBundle(r.bundle),
  };
}
