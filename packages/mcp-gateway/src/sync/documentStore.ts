/**
 * Encrypted, signed, revisioned storage for arbitrary JSON documents.
 *
 * Project configs already had all of this, but only for project configs. Settings,
 * per-device folder bindings, and the opt-in credential bundle need exactly the
 * same properties — encryption at rest, an Ed25519 signature checked against the
 * trust registry, monotonic revisions with compare-and-swap, and refusal rather
 * than last-write-wins — so this layer generalises the mechanism instead of
 * growing a second one beside it.
 *
 * Two scopes, and the distinction is load-bearing:
 *
 *   - `shared` documents describe the repository. Every device reads and writes
 *     the same object, so they are for things all devices should agree on.
 *   - `device` documents describe ONE machine. They are backed up so that machine
 *     can be restored, but they are never presented to a different machine as
 *     shared truth — a folder layout full of `/Users/alice/...` paths is a backup
 *     of one device, not a fact about the account.
 *
 * What is NOT here: merge logic. A losing compare-and-swap is reported, never
 * resolved silently, because only the caller knows whether two versions of a
 * document can be combined.
 */

import { canonicalize, canonicalBytes, type JsonValue } from "../canonicalJson.js";
import { isSafeId } from "../ids.js";
import {
  assertTrustedSigner,
  verifyEd25519,
  verifyTrustRegistry,
  VerificationError,
  type TrustRegistry,
} from "../trust.js";
import type { SigningKey } from "../vault.js";
import { open, seal, kdfJson, type CryptoEnvelope } from "./crypto.js";
import { isStoreErrorKind, type SyncObjectStore } from "./objectStore.js";
import { documentKey, type DocumentScope } from "./keys.js";

export const DOCUMENT_RECORD_VERSION = 1 as const;
/** Generous for settings and binding lists; still a hard bound on a remote read. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** The signed part of a document record. */
export interface DocumentBody {
  readonly docVersion: typeof DOCUMENT_RECORD_VERSION;
  readonly scope: DocumentScope;
  /** Document name, e.g. "settings" or "workspaces". */
  readonly name: string;
  /** Owning device for `device` scope; empty string for `shared`. */
  readonly deviceId: string;
  /** Monotonic revision, per document. */
  readonly revision: number;
  readonly signer: string;
  /** SHA-256 hex of the canonical plaintext, so the payload cannot be swapped. */
  readonly hash: string;
}

export interface DocumentEnvelope extends DocumentBody {
  readonly signature: string;
}

/** A document as stored: signed envelope plus the sealed payload. */
export interface DocumentRecord {
  readonly recordVersion: typeof DOCUMENT_RECORD_VERSION;
  readonly envelope: DocumentEnvelope;
  readonly payload: CryptoEnvelope;
}

export class DocumentStoreError extends Error {
  override readonly name = "DocumentStoreError";
  constructor(
    message: string,
    readonly code: "malformed" | "config" | "store",
  ) {
    super(message);
  }
}

/** A successful read. */
export interface LoadedDocument<T = unknown> {
  readonly scope: DocumentScope;
  readonly name: string;
  readonly deviceId?: string;
  readonly revision: number;
  readonly signer: string;
  readonly value: T;
}

/** A read that could not be trusted. The value is never returned. */
export interface RejectedDocument {
  readonly scope: DocumentScope;
  readonly name: string;
  readonly deviceId?: string;
  /** Envelope signer, available once the outer record has parsed successfully. */
  readonly signer?: string;
  readonly reason: string;
  readonly code:
    | "malformed"
    | "decrypt"
    | "bad-signature"
    | "hash-mismatch"
    | "unknown-signer"
    | "revoked-signer"
    | "rollback"
    | "id-mismatch";
}

export type DocumentReadResult<T = unknown> =
  | { readonly kind: "loaded"; readonly document: LoadedDocument<T> }
  | { readonly kind: "rejected"; readonly rejection: RejectedDocument }
  | { readonly kind: "absent" };

export interface DocumentPublished {
  readonly kind: "published";
  readonly revision: number;
}

/**
 * The remote moved on before we could write. The caller keeps its local copy and
 * decides; this layer never merges or overwrites.
 */
export interface DocumentConflict {
  readonly kind: "conflict";
  readonly attemptedRevision: number;
  readonly remoteRevision: number;
}

export type DocumentPublishResult = DocumentPublished | DocumentConflict;

export interface SyncedDocumentStoreConfig {
  readonly store: SyncObjectStore;
  readonly controlPrefix: string;
  /** Operator encryption password. Held in memory only. */
  readonly password: string;
  /** Per-repository salt (hex) used when sealing. */
  readonly saltHex: string;
  readonly signingKey: SigningKey;
}

const encoder = new TextEncoder();

function bodyJson(body: DocumentBody): JsonValue {
  return {
    docVersion: body.docVersion,
    scope: body.scope,
    name: body.name,
    deviceId: body.deviceId,
    revision: body.revision,
    signer: body.signer,
    hash: body.hash,
  };
}

function recordJson(record: DocumentRecord): JsonValue {
  return {
    recordVersion: record.recordVersion,
    envelope: {
      ...(bodyJson(record.envelope) as Record<string, JsonValue>),
      signature: record.envelope.signature,
    },
    payload: {
      header: {
        v: record.payload.header.v,
        alg: record.payload.header.alg,
        kdf: kdfJson(record.payload.header.kdf),
        saltHex: record.payload.header.saltHex,
        nonceHex: record.payload.header.nonceHex,
        context: record.payload.header.context,
      },
      ciphertext: record.payload.ciphertext,
      tag: record.payload.tag,
    },
  } as JsonValue;
}

function decodeRecord(bytes: Uint8Array): DocumentRecord {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentStoreError("document exceeds size cap", "malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DocumentStoreError("document is not valid JSON/UTF-8", "malformed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DocumentStoreError("document must be an object", "malformed");
  }
  const p = parsed as Record<string, unknown>;
  if (p.recordVersion !== DOCUMENT_RECORD_VERSION) {
    throw new DocumentStoreError("unsupported document recordVersion", "malformed");
  }
  const env = p.envelope;
  if (typeof env !== "object" || env === null) {
    throw new DocumentStoreError("document envelope must be an object", "malformed");
  }
  const e = env as Record<string, unknown>;
  if (e.docVersion !== DOCUMENT_RECORD_VERSION) {
    throw new DocumentStoreError("unsupported docVersion", "malformed");
  }
  if (e.scope !== "shared" && e.scope !== "device") {
    throw new DocumentStoreError("bad document scope", "malformed");
  }
  if (typeof e.name !== "string" || !isSafeId(e.name)) {
    throw new DocumentStoreError("bad document name", "malformed");
  }
  if (typeof e.deviceId !== "string") {
    throw new DocumentStoreError("bad document deviceId", "malformed");
  }
  if (typeof e.revision !== "number" || !Number.isInteger(e.revision) || e.revision < 1) {
    throw new DocumentStoreError("bad document revision", "malformed");
  }
  if (typeof e.signer !== "string") {
    throw new DocumentStoreError("bad document signer", "malformed");
  }
  if (typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) {
    throw new DocumentStoreError("bad document hash", "malformed");
  }
  if (typeof e.signature !== "string" || !/^[0-9a-f]+$/.test(e.signature)) {
    throw new DocumentStoreError("bad document signature", "malformed");
  }
  const payload = p.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new DocumentStoreError("document payload must be an object", "malformed");
  }
  return {
    recordVersion: DOCUMENT_RECORD_VERSION,
    envelope: {
      docVersion: DOCUMENT_RECORD_VERSION,
      scope: e.scope,
      name: e.name,
      deviceId: e.deviceId,
      revision: e.revision,
      signer: e.signer,
      hash: e.hash,
      signature: e.signature,
    },
    payload: payload as CryptoEnvelope,
  };
}

export class SyncedDocumentStore {
  private readonly store: SyncObjectStore;
  private readonly controlPrefix: string;
  private readonly password: string;
  private readonly saltHex: string;
  private readonly signingKey: SigningKey;

  constructor(config: SyncedDocumentStoreConfig) {
    this.store = config.store;
    this.controlPrefix = config.controlPrefix;
    this.password = config.password;
    this.saltHex = config.saltHex;
    this.signingKey = config.signingKey;
  }

  /** This device's signer id, for "is this my document?" decisions. */
  get selfDeviceId(): string {
    return this.signingKey.deviceId;
  }

  /**
   * The logical slot a payload is bound to. Mixed into the AEAD additional data,
   * so even a password holder cannot move a ciphertext from one document to
   * another — a device's bindings cannot be replayed as the shared settings.
   */
  private context(scope: DocumentScope, name: string, deviceId: string): string {
    return `doc:${scope}:${deviceId}:${name}`;
  }

  private keyFor(scope: DocumentScope, name: string, deviceId?: string): string {
    return documentKey(this.controlPrefix, scope, name, deviceId);
  }

  private async hash(plaintext: Uint8Array): Promise<string> {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(plaintext).digest("hex");
  }

  /**
   * Write `value` at `revision`. The first write uses revision 1 and a
   * conditional create; later writes compare-and-swap against the current head
   * and must be exactly one past it.
   *
   * A lost race returns a {@link DocumentConflict} — the remote stays
   * authoritative and nothing is overwritten.
   */
  async publish(
    scope: DocumentScope,
    name: string,
    value: JsonValue,
    revision: number,
    deviceId?: string,
  ): Promise<DocumentPublishResult> {
    if (!Number.isInteger(revision) || revision < 1) {
      throw new DocumentStoreError("revision must be a positive integer", "config");
    }
    const owner = scope === "device" ? (deviceId ?? this.signingKey.deviceId) : "";
    const key = this.keyFor(scope, name, scope === "device" ? owner : undefined);
    const plaintext = encoder.encode(canonicalize(value));
    const hash = await this.hash(plaintext);

    const body: DocumentBody = {
      docVersion: DOCUMENT_RECORD_VERSION,
      scope,
      name,
      deviceId: owner,
      revision,
      signer: this.signingKey.deviceId,
      hash,
    };
    const signature = await this.signingKey.sign(canonicalBytes(bodyJson(body)));
    const record: DocumentRecord = {
      recordVersion: DOCUMENT_RECORD_VERSION,
      envelope: { ...body, signature },
      payload: seal(this.password, plaintext, {
        saltHex: this.saltHex,
        context: this.context(scope, name, owner),
      }),
    };
    const encoded = encoder.encode(canonicalize(recordJson(record)));

    const current = await this.readRaw(key);
    if (current === null) {
      if (revision !== 1) {
        throw new DocumentStoreError(`first publish must be revision 1, got ${revision}`, "config");
      }
      try {
        await this.store.putCreate(key, encoded);
        return { kind: "published", revision };
      } catch (err) {
        if (isStoreErrorKind(err, "PreconditionFailed", "Conflict")) {
          const fresh = await this.readRaw(key);
          return {
            kind: "conflict",
            attemptedRevision: revision,
            remoteRevision: fresh?.revision ?? revision,
          };
        }
        throw err;
      }
    }

    if (revision <= current.revision) {
      return { kind: "conflict", attemptedRevision: revision, remoteRevision: current.revision };
    }
    if (revision !== current.revision + 1) {
      throw new DocumentStoreError(
        `non-contiguous revision: head at ${current.revision}, cannot publish ${revision}`,
        "config",
      );
    }
    try {
      await this.store.putCompareAndSwap(key, encoded, current.etag);
      return { kind: "published", revision };
    } catch (err) {
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict", "NotFound")) {
        const fresh = await this.readRaw(key);
        return {
          kind: "conflict",
          attemptedRevision: revision,
          remoteRevision: fresh?.revision ?? current.revision,
        };
      }
      throw err;
    }
  }

  /** Current revision + etag of a stored document, or null when absent. */
  private async readRaw(key: string): Promise<{ revision: number; etag: string } | null> {
    try {
      const got = await this.store.get(key);
      return { revision: decodeRecord(got.bytes).envelope.revision, etag: got.etag };
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      // A corrupt head still has an etag we can compare-and-swap against, so the
      // document is recoverable by publishing over it.
      if (err instanceof DocumentStoreError) {
        const got = await this.store.get(key);
        return { revision: 0, etag: got.etag };
      }
      throw err;
    }
  }

  /**
   * Read and fully verify a document. Never throws for an untrustworthy record:
   * the result says whether it loaded, was rejected (and why), or is absent, so
   * one bad document cannot abort a multi-document restore.
   *
   * `lastAppliedRevision` gives replay protection against an older record being
   * served back.
   */
  async read<T = unknown>(
    scope: DocumentScope,
    name: string,
    registry: TrustRegistry,
    options: { deviceId?: string; lastAppliedRevision?: number } = {},
  ): Promise<DocumentReadResult<T>> {
    verifyTrustRegistry(registry);
    const owner = scope === "device" ? (options.deviceId ?? this.signingKey.deviceId) : "";
    const key = this.keyFor(scope, name, scope === "device" ? owner : undefined);
    const identity = {
      scope,
      name,
      ...(scope === "device" ? { deviceId: owner } : {}),
    };

    let bytes: Uint8Array;
    try {
      const got = await this.store.get(key);
      bytes = got.bytes;
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return { kind: "absent" };
      throw err;
    }

    let record: DocumentRecord;
    try {
      record = decodeRecord(bytes);
    } catch (err) {
      return {
        kind: "rejected",
        rejection: { ...identity, reason: (err as Error).message, code: "malformed" },
      };
    }

    const env = record.envelope;
    // The envelope must describe the slot it was found in, so a record cannot be
    // moved between documents or devices.
    if (env.scope !== scope || env.name !== name || env.deviceId !== owner) {
      return {
        kind: "rejected",
        rejection: {
          ...identity,
          reason: "envelope does not describe this document slot",
          code: "id-mismatch",
        },
      };
    }

    try {
      const entry = assertTrustedSigner(registry, env.signer);
      if (!verifyEd25519(entry.publicKeyHex, canonicalBytes(bodyJson(env)), env.signature)) {
        throw new VerificationError("Document signature invalid", "bad-signature");
      }
    } catch (err) {
      if (err instanceof VerificationError) {
        return {
          kind: "rejected",
          rejection: {
            ...identity,
            signer: env.signer,
            reason: err.message,
            code: err.code,
          },
        };
      }
      throw err;
    }

    const last = options.lastAppliedRevision ?? 0;
    if (env.revision <= last) {
      return {
        kind: "rejected",
        rejection: {
          ...identity,
          reason: `Rollback: revision ${env.revision} <= last applied ${last}`,
          code: "rollback",
        },
      };
    }

    let plaintext: Uint8Array;
    try {
      plaintext = open(this.password, record.payload, this.context(scope, name, owner));
    } catch (err) {
      return {
        kind: "rejected",
        rejection: { ...identity, reason: (err as Error).message, code: "decrypt" },
      };
    }

    // The signature covers the hash, not the ciphertext, so the plaintext has to
    // be checked against it — otherwise a password holder could re-seal different
    // content under someone else's signature.
    if ((await this.hash(plaintext)) !== env.hash) {
      return {
        kind: "rejected",
        rejection: {
          ...identity,
          reason: "payload hash does not match envelope",
          code: "hash-mismatch",
        },
      };
    }

    let value: T;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as T;
    } catch (err) {
      return {
        kind: "rejected",
        rejection: { ...identity, reason: (err as Error).message, code: "malformed" },
      };
    }

    return {
      kind: "loaded",
      document: {
        ...identity,
        revision: env.revision,
        signer: env.signer,
        value,
      },
    };
  }
}
