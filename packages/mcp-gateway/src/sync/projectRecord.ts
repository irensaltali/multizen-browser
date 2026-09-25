/**
 * The on-store record for a synchronized project.
 *
 * A project's head object (`.../projects/<id>/state.json`) and each immutable
 * revision object (`.../projects/<id>/rev/<n>.json`) hold the SAME shape: a
 * {@link ProjectRecord}. It binds three things together so a reader can verify
 * everything independently of any local trust-on-first-use:
 *
 *   - `envelope` — the Ed25519 {@link ProjectEnvelope} (project id, revision,
 *     signer, config hash, signature). Cleartext: it carries no secret and must
 *     be verifiable by a fresh device.
 *   - `payload`  — the AES-256-GCM {@link CryptoEnvelope} wrapping the canonical
 *     JSON of the ProjectConfig. Confidential + authenticated at rest.
 *
 * The config plaintext is NEVER stored in the clear. The signed envelope commits
 * to the *hash* of the config, so tamper detection does not require decrypting:
 * a reader decrypts the payload, reparses the config, recomputes the hash, and
 * checks it equals `envelope.hash`. If decryption fails (wrong password/tamper)
 * the record is quarantined without ever trusting its bytes.
 *
 * The record is itself validated strictly on decode: unknown keys, wrong types,
 * or an oversized body are rejected as malformed rather than trusted.
 */

import { canonicalize, type JsonValue } from "../canonicalJson.js";
import { kdfJson, type CryptoEnvelope } from "./crypto.js";
import type { ProjectEnvelope } from "../trust.js";

/** Current record schema version. */
export const PROJECT_RECORD_VERSION = 1 as const;

/** Defensive cap on a single stored project record (bytes of canonical JSON). */
export const MAX_RECORD_BYTES = 256 * 1024;

export interface ProjectRecord {
  readonly recordVersion: typeof PROJECT_RECORD_VERSION;
  /** Ed25519 signed envelope committing to the config hash + revision. */
  readonly envelope: ProjectEnvelope;
  /** AES-256-GCM envelope wrapping the canonical config JSON. */
  readonly payload: CryptoEnvelope;
}

export class RecordError extends Error {
  override readonly name = "RecordError";
  constructor(
    message: string,
    readonly code: "malformed" | "too-large",
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Canonical JSON shape of a stored record. Exported because the revision archive
 * wraps a record and must hash exactly the same bytes the head is signed over.
 */
export function projectRecordJson(record: ProjectRecord): JsonValue {
  return {
    recordVersion: record.recordVersion,
    envelope: {
      envelopeVersion: record.envelope.envelopeVersion,
      project: record.envelope.project,
      revision: record.envelope.revision,
      signer: record.envelope.signer,
      hash: record.envelope.hash,
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
  };
}

/** Serialize a record to canonical JSON bytes, enforcing the size cap. */
export function encodeRecord(record: ProjectRecord): Uint8Array {
  const bytes = encoder.encode(canonicalize(projectRecordJson(record)));
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new RecordError("encoded project record exceeds size cap", "too-large");
  }
  return bytes;
}

function decodeEnvelope(v: unknown): ProjectEnvelope {
  if (!isPlainObject(v)) throw new RecordError("envelope must be an object", "malformed");
  const allowed = ["envelopeVersion", "project", "revision", "signer", "hash", "signature"];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new RecordError(`unknown envelope key ${k}`, "malformed");
  }
  if (v.envelopeVersion !== 1) throw new RecordError("bad envelopeVersion", "malformed");
  if (typeof v.project !== "string") throw new RecordError("bad project", "malformed");
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) {
    throw new RecordError("bad revision", "malformed");
  }
  if (typeof v.signer !== "string") throw new RecordError("bad signer", "malformed");
  if (typeof v.hash !== "string" || !/^[0-9a-f]{64}$/.test(v.hash)) {
    throw new RecordError("bad hash", "malformed");
  }
  if (typeof v.signature !== "string" || !/^[0-9a-f]+$/.test(v.signature)) {
    throw new RecordError("bad signature", "malformed");
  }
  return {
    envelopeVersion: 1,
    project: v.project as ProjectEnvelope["project"],
    revision: v.revision,
    signer: v.signer,
    hash: v.hash,
    signature: v.signature,
  };
}

function decodePayload(v: unknown): CryptoEnvelope {
  if (!isPlainObject(v)) throw new RecordError("payload must be an object", "malformed");
  const allowed = ["header", "ciphertext", "tag"];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new RecordError(`unknown payload key ${k}`, "malformed");
  }
  if (typeof v.ciphertext !== "string") throw new RecordError("bad ciphertext", "malformed");
  if (typeof v.tag !== "string") throw new RecordError("bad tag", "malformed");
  const h = v.header;
  if (!isPlainObject(h)) throw new RecordError("bad header", "malformed");
  const kdf = h.kdf;
  if (!isPlainObject(kdf)) throw new RecordError("bad kdf", "malformed");
  // Detailed field validation is performed by crypto.open()'s validateHeader;
  // here we only assert structural shape so the record round-trips. The
  // authenticated decrypt is the true gate.
  return {
    header: {
      v: h.v as CryptoEnvelope["header"]["v"],
      alg: h.alg as CryptoEnvelope["header"]["alg"],
      kdf: {
        algorithm: kdf.algorithm as "scrypt",
        n: kdf.n as number,
        r: kdf.r as number,
        p: kdf.p as number,
        keyLenBytes: kdf.keyLenBytes as number,
      },
      saltHex: h.saltHex as string,
      nonceHex: h.nonceHex as string,
      context: h.context as string,
    },
    ciphertext: v.ciphertext,
    tag: v.tag,
  };
}

/**
 * Decode and structurally validate a stored project record. Throws
 * {@link RecordError} on malformed/oversized input. Cryptographic validity
 * (signature, hash, decrypt) is checked by the synchronizer, not here.
 */
export function decodeRecord(bytes: Uint8Array): ProjectRecord {
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new RecordError("project record exceeds size cap", "too-large");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new RecordError("record is not valid UTF-8", "malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecordError("record is not valid JSON", "malformed");
  }
  if (!isPlainObject(parsed)) throw new RecordError("record must be an object", "malformed");
  for (const k of Object.keys(parsed)) {
    if (!["recordVersion", "envelope", "payload"].includes(k)) {
      throw new RecordError(`unknown record key ${k}`, "malformed");
    }
  }
  if (parsed.recordVersion !== PROJECT_RECORD_VERSION) {
    throw new RecordError("unsupported recordVersion", "malformed");
  }
  return {
    recordVersion: PROJECT_RECORD_VERSION,
    envelope: decodeEnvelope(parsed.envelope),
    payload: decodePayload(parsed.payload),
  };
}
