/**
 * Trust-registry synchronization with first-device trust-root bootstrap.
 *
 * The trust registry (see trust.ts) is a signed document mapping device ids to
 * a role (`trusted`/`revoked`) and public key. It is the root of authority for
 * every project envelope: a config is only an apply candidate if its signer is
 * a `trusted` entry in a self-verifying registry. This module owns publishing
 * and fetching that registry through the object store.
 *
 * Design:
 *   - The registry is stored in the reserved MCP namespace at
 *     `<prefix>/mcp/trust/registry.json`. It is NOT encrypted: it contains only
 *     PUBLIC keys and roles, and a fresh device must read it before it has any
 *     project payload key context. Confidentiality is unnecessary; integrity is
 *     everything, and that is provided by the Ed25519 self-signature.
 *   - First-device bootstrap: the very first device creates the registry with a
 *     conditional create (`putCreate`). It seeds itself as the sole `trusted`
 *     entry (the trust root). Because the registry self-verifies (its signer
 *     must be a `trusted` entry whose key validates the signature), any later
 *     reader can validate it with no prior state — this is the honest
 *     fresh-device semantics: a fresh device trusts whatever self-consistent
 *     registry it first fetches from the shared bucket. Operators must therefore
 *     protect bucket write access; a party who can write the bucket before the
 *     legitimate first device could seed a hostile root (documented limitation).
 *   - Updates: adding/revoking a device is a new registry revision signed by an
 *     ACTIVE trusted admin (a device that is `trusted` in the CURRENT registry).
 *     Updates use compare-and-swap against the current etag and a strictly
 *     greater revision, so two admins racing cannot silently lose an update
 *     (the loser retries from a fresh read). Private signing keys never leave
 *     the vault; only public keys are written.
 */

import {
  signTrustRegistry,
  verifyEd25519,
  verifyTrustRegistry,
  VerificationError,
  type TrustEntry,
  type TrustRegistry,
} from "../trust.js";
import type { PublicKeyHex, SigningKey } from "../vault.js";
import { deviceIdFromPublicKey } from "../vault.js";
import { canonicalBytes, canonicalize, type JsonValue } from "../canonicalJson.js";
import {
  parsePendingDeviceKey,
  pendingDeviceKey,
  pendingDevicesPrefix,
  trustRegistryKey,
} from "./keys.js";
import { isStoreErrorKind, type SyncObjectStore } from "./objectStore.js";

const encoder = new TextEncoder();
const MAX_REGISTRY_BYTES = 256 * 1024;

export class TrustSyncError extends Error {
  override readonly name = "TrustSyncError";
  constructor(
    message: string,
    readonly code:
      | "not-admin"
      | "conflict"
      | "not-found"
      | "malformed"
      | "invalid-registry"
      | "store",
  ) {
    super(message);
  }
}

function registryToJson(reg: TrustRegistry): JsonValue {
  return {
    registryVersion: reg.registryVersion,
    revision: reg.revision,
    signer: reg.signer,
    entries: reg.entries.map((e) => ({
      deviceId: e.deviceId,
      publicKeyHex: e.publicKeyHex,
      role: e.role,
    })),
    signature: reg.signature,
  };
}

function decodeRegistry(bytes: Uint8Array): TrustRegistry {
  if (bytes.byteLength > MAX_REGISTRY_BYTES) {
    throw new TrustSyncError("trust registry exceeds size cap", "malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TrustSyncError("trust registry is not valid JSON/UTF-8", "malformed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TrustSyncError("trust registry must be an object", "malformed");
  }
  const p = parsed as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!["registryVersion", "revision", "signer", "entries", "signature"].includes(k)) {
      throw new TrustSyncError(`unknown registry key ${k}`, "malformed");
    }
  }
  if (p.registryVersion !== 1) throw new TrustSyncError("bad registryVersion", "malformed");
  if (typeof p.revision !== "number" || !Number.isInteger(p.revision) || p.revision < 1) {
    throw new TrustSyncError("bad registry revision", "malformed");
  }
  if (typeof p.signer !== "string") throw new TrustSyncError("bad signer", "malformed");
  if (typeof p.signature !== "string" || !/^[0-9a-f]+$/.test(p.signature)) {
    throw new TrustSyncError("bad signature", "malformed");
  }
  if (!Array.isArray(p.entries)) throw new TrustSyncError("entries must be an array", "malformed");
  const entries: TrustEntry[] = p.entries.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TrustSyncError(`entry ${i} must be an object`, "malformed");
    }
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!["deviceId", "publicKeyHex", "role"].includes(k)) {
        throw new TrustSyncError(`entry ${i} unknown key ${k}`, "malformed");
      }
    }
    if (typeof e.deviceId !== "string") throw new TrustSyncError(`entry ${i} bad deviceId`, "malformed");
    if (typeof e.publicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(e.publicKeyHex)) {
      throw new TrustSyncError(`entry ${i} bad publicKeyHex`, "malformed");
    }
    if (e.role !== "trusted" && e.role !== "revoked") {
      throw new TrustSyncError(`entry ${i} bad role`, "malformed");
    }
    return {
      deviceId: e.deviceId,
      publicKeyHex: e.publicKeyHex as TrustEntry["publicKeyHex"],
      role: e.role,
    };
  });
  return {
    registryVersion: 1,
    revision: p.revision,
    signer: p.signer,
    entries,
    signature: p.signature,
  };
}

export interface FetchResult {
  readonly registry: TrustRegistry;
  readonly etag: string;
}

/**
 * A device's self-signed announcement that it exists and would like to be
 * trusted.
 *
 * Purely a discovery aid. It confers nothing: `deviceId` is derived from
 * `publicKeyHex`, so an announcement cannot lie about which key it names, and
 * approving one still requires an already-trusted admin. Announcing a key you do
 * not hold is pointless — the signature proves possession, and approving a key
 * without its private half grants authority to nobody.
 */
export interface PendingDevice {
  readonly deviceId: string;
  readonly publicKeyHex: PublicKeyHex;
  /** Operator-facing device name, so the approval prompt is recognisable. */
  readonly name: string;
  /** ISO timestamp the announcement was written.  */
  readonly announcedAt: string;
}

const PENDING_VERSION = 1 as const;
const MAX_PENDING_BYTES = 8 * 1024;
const MAX_PENDING_SCAN = 500;

function pendingBodyJson(d: PendingDevice): JsonValue {
  return {
    pendingVersion: PENDING_VERSION,
    deviceId: d.deviceId,
    publicKeyHex: d.publicKeyHex,
    name: d.name,
    announcedAt: d.announcedAt,
  };
}

function decodePending(bytes: Uint8Array): PendingDevice | null {
  if (bytes.byteLength > MAX_PENDING_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (
      !["pendingVersion", "deviceId", "publicKeyHex", "name", "announcedAt", "signature"].includes(k)
    ) {
      return null;
    }
  }
  if (p.pendingVersion !== PENDING_VERSION) return null;
  if (typeof p.deviceId !== "string" || typeof p.name !== "string") return null;
  if (typeof p.announcedAt !== "string") return null;
  if (typeof p.publicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(p.publicKeyHex)) return null;
  if (typeof p.signature !== "string" || !/^[0-9a-f]+$/.test(p.signature)) return null;
  const publicKeyHex = p.publicKeyHex as PublicKeyHex;
  // The id must be the one derived from the key: an announcement cannot claim to
  // be a different device than the key it presents.
  if (deviceIdFromPublicKey(publicKeyHex) !== p.deviceId) return null;
  const device: PendingDevice = {
    deviceId: p.deviceId,
    publicKeyHex,
    name: p.name,
    announcedAt: p.announcedAt,
  };
  // Self-signature proves possession of the private half, so the record is not
  // junk written by a third party.
  if (!verifyEd25519(publicKeyHex, canonicalBytes(pendingBodyJson(device)), p.signature)) {
    return null;
  }
  return device;
}

export class TrustRegistrySync {
  constructor(
    private readonly store: SyncObjectStore,
    private readonly controlPrefix: string,
  ) {}

  private key(): string {
    return trustRegistryKey(this.controlPrefix);
  }

  /**
   * Fetch and self-verify the current registry. Returns null when none exists.
   * Throws {@link TrustSyncError} `invalid-registry` if a present registry fails
   * its self-signature (a tampered root is never returned as usable).
   */
  async fetch(): Promise<FetchResult | null> {
    let bytes: Uint8Array;
    let etag: string;
    try {
      const got = await this.store.get(this.key());
      bytes = got.bytes;
      etag = got.etag;
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
    const registry = decodeRegistry(bytes);
    try {
      verifyTrustRegistry(registry);
    } catch (err) {
      if (err instanceof VerificationError) {
        throw new TrustSyncError(`stored registry invalid: ${err.message}`, "invalid-registry");
      }
      throw err;
    }
    return { registry, etag };
  }

  /**
   * First-device bootstrap: create the registry with `key` as the sole trusted
   * trust-root. Uses a conditional create so a second concurrent bootstrap
   * loses cleanly (returns the existing registry instead of overwriting).
   */
  async bootstrap(key: SigningKey): Promise<TrustRegistry> {
    const entries: TrustEntry[] = [
      { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
    ];
    const registry = await signTrustRegistry(key, 1, entries);
    verifyTrustRegistry(registry);
    const body = encoder.encode(canonicalize(registryToJson(registry)));
    try {
      await this.store.putCreate(this.key(), body);
      return registry;
    } catch (err) {
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict")) {
        const existing = await this.fetch();
        if (existing) return existing.registry;
      }
      throw err;
    }
  }

  /** Fetch the existing registry or bootstrap a fresh one if none exists. */
  async fetchOrBootstrap(key: SigningKey): Promise<TrustRegistry> {
    const existing = await this.fetch();
    if (existing) return existing.registry;
    return this.bootstrap(key);
  }

  /**
   * Publish (or refresh) this device's self-signed announcement so an admin on
   * another device can see it and approve it.
   *
   * Overwrites this device's own record unconditionally — it owns that key, and
   * the name or timestamp may have changed. Failures are surfaced to the caller,
   * but callers treat this as best-effort: not being able to announce must never
   * stop the gateway from working locally.
   */
  async announce(key: SigningKey, name: string, now = new Date()): Promise<PendingDevice> {
    const device: PendingDevice = {
      deviceId: key.deviceId,
      publicKeyHex: key.publicKeyHex,
      name,
      announcedAt: now.toISOString(),
    };
    const signature = await key.sign(canonicalBytes(pendingBodyJson(device)));
    const body = encoder.encode(
      canonicalize({ ...(pendingBodyJson(device) as Record<string, JsonValue>), signature }),
    );
    const objectKey = pendingDeviceKey(this.controlPrefix, key.deviceId);
    try {
      await this.store.putCreate(objectKey, body);
    } catch (err) {
      if (!isStoreErrorKind(err, "PreconditionFailed", "Conflict")) throw err;
      // Already announced: replace our own record so the name stays current.
      const existing = await this.store.get(objectKey);
      await this.store.putCompareAndSwap(objectKey, body, existing.etag);
    }
    return device;
  }

  /**
   * Every valid self-announcement in the bucket. Malformed, oversized, or
   * badly-signed records are skipped rather than failing the listing, so one bad
   * object cannot hide every other device from the approval UI.
   */
  async listPending(): Promise<PendingDevice[]> {
    const prefix = pendingDevicesPrefix(this.controlPrefix);
    const out: PendingDevice[] = [];
    let continuationToken: string | undefined;
    let scanned = 0;
    do {
      const page = await this.store.list(prefix, {
        maxKeys: 100,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      for (const objectKey of page.keys) {
        if (scanned >= MAX_PENDING_SCAN) break;
        const id = parsePendingDeviceKey(this.controlPrefix, objectKey);
        if (id === null) continue;
        scanned += 1;
        try {
          const got = await this.store.get(objectKey);
          const device = decodePending(got.bytes);
          // The filename must agree with the signed content.
          if (device !== null && device.deviceId === id) out.push(device);
        } catch {
          // Unreadable object: skip it, keep listing.
        }
      }
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken !== undefined && scanned < MAX_PENDING_SCAN);
    return out.sort((a, b) => a.announcedAt.localeCompare(b.announcedAt));
  }

  /**
   * Publish a new registry revision. The `adminKey` MUST be an ACTIVE trusted
   * entry in the CURRENT registry; otherwise the update is refused (`not-admin`)
   * — an untrusted or revoked device can never rewrite the trust root. The write
   * is a compare-and-swap against the fetched etag with a strictly greater
   * revision, so a racing admin loses cleanly (`conflict`) and must retry from a
   * fresh read.
   */
  async update(adminKey: SigningKey, entries: readonly TrustEntry[]): Promise<TrustRegistry> {
    const current = await this.fetch();
    if (current === null) {
      throw new TrustSyncError("no registry to update; bootstrap first", "not-found");
    }
    const adminEntry = current.registry.entries.find((e) => e.deviceId === adminKey.deviceId);
    if (!adminEntry || adminEntry.role !== "trusted") {
      throw new TrustSyncError(
        `device ${adminKey.deviceId} is not an active trusted admin`,
        "not-admin",
      );
    }
    // Bind id↔key: the admin's registered public key must match its signing key.
    if (
      adminEntry.publicKeyHex !== adminKey.publicKeyHex ||
      deviceIdFromPublicKey(adminKey.publicKeyHex) !== adminKey.deviceId
    ) {
      throw new TrustSyncError("admin id/key mismatch", "not-admin");
    }
    const nextRevision = current.registry.revision + 1;
    const next = await signTrustRegistry(adminKey, nextRevision, entries);
    verifyTrustRegistry(next);
    const body = encoder.encode(canonicalize(registryToJson(next)));
    try {
      await this.store.putCompareAndSwap(this.key(), body, current.etag);
      return next;
    } catch (err) {
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict", "NotFound")) {
        throw new TrustSyncError(
          "trust registry changed concurrently; retry from a fresh fetch",
          "conflict",
        );
      }
      throw err;
    }
  }
}
