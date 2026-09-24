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
  verifyTrustRegistry,
  VerificationError,
  type TrustEntry,
  type TrustRegistry,
} from "../trust.js";
import type { SigningKey } from "../vault.js";
import { deviceIdFromPublicKey } from "../vault.js";
import { canonicalize, type JsonValue } from "../canonicalJson.js";
import { trustRegistryKey } from "./keys.js";
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
