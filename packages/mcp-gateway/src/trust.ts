/**
 * Signed project envelopes and the device trust registry.
 *
 * A ProjectEnvelope binds a specific project config revision to the device that
 * produced it, via an Ed25519 signature over the canonical JSON of the envelope
 * body. The body carries: project id, monotonically increasing revision, signer
 * device id, and the SHA-256 hash of the config's canonical JSON. Verification
 * recomputes the hash from the presented config and checks the signature
 * against the signer's public key as recorded in a signed TrustRegistry.
 *
 * The TrustRegistry is itself an envelope-like signed document mapping device
 * ids to a role (`trusted` or `revoked`) and their public key. A config from a
 * revoked or unknown signer is *quarantined* (rejected, not applied). A config
 * whose revision is not strictly greater than the last-applied revision is a
 * *rollback* and is rejected to prevent replay of stale, previously-valid
 * configs.
 *
 * Private keys and expanded env values never appear in any of these documents.
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

import { canonicalBytes, type JsonValue } from "./canonicalJson.js";
import { type ProjectId } from "./ids.js";
import { projectConfigToJson, type ProjectConfig } from "./projectConfig.js";
import {
  deviceIdFromPublicKey,
  type PublicKeyHex,
  type SigningKey,
} from "./vault.js";

export const ENVELOPE_VERSION = 1 as const;
export const TRUST_REGISTRY_VERSION = 1 as const;

export type TrustRole = "trusted" | "revoked";

export interface EnvelopeBody {
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  readonly project: ProjectId;
  /** Monotonic revision; strictly increasing per project. */
  readonly revision: number;
  /** Device id of the signer. */
  readonly signer: string;
  /** SHA-256 hex of the canonical JSON of the config payload. */
  readonly hash: string;
}

export interface ProjectEnvelope extends EnvelopeBody {
  /** Hex Ed25519 signature over canonicalBytes(body). */
  readonly signature: string;
}

export interface TrustEntry {
  readonly deviceId: string;
  readonly publicKeyHex: PublicKeyHex;
  readonly role: TrustRole;
}

export interface TrustRegistryBody {
  readonly registryVersion: typeof TRUST_REGISTRY_VERSION;
  readonly revision: number;
  readonly signer: string;
  readonly entries: readonly TrustEntry[];
}

export interface TrustRegistry extends TrustRegistryBody {
  readonly signature: string;
}

export class VerificationError extends Error {
  override readonly name = "VerificationError";
  constructor(
    message: string,
    readonly code:
      | "bad-signature"
      | "hash-mismatch"
      | "unknown-signer"
      | "revoked-signer"
      | "rollback"
      | "malformed",
  ) {
    super(message);
  }
}

/** SHA-256 hex of the canonical JSON of a config payload. */
export function hashConfig(config: ProjectConfig): string {
  const json = projectConfigToJson(config) as JsonValue;
  return createHash("sha256").update(canonicalBytes(json)).digest("hex");
}

function envelopeBodyJson(body: EnvelopeBody): JsonValue {
  return {
    envelopeVersion: body.envelopeVersion,
    project: body.project,
    revision: body.revision,
    signer: body.signer,
    hash: body.hash,
  };
}

function registryBodyJson(body: TrustRegistryBody): JsonValue {
  return {
    registryVersion: body.registryVersion,
    revision: body.revision,
    signer: body.signer,
    entries: body.entries.map((e) => ({
      deviceId: e.deviceId,
      publicKeyHex: e.publicKeyHex,
      role: e.role,
    })),
  };
}

/** Ed25519 public KeyObject import helper from raw hex. */
function verifyEd25519(publicKeyHex: string, message: Uint8Array, sigHex: string): boolean {
  try {
    const raw = Buffer.from(publicKeyHex, "hex");
    if (raw.length !== 32) return false;
    // Wrap raw key in SPKI DER for KeyObject import.
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    const der = Buffer.concat([prefix, raw]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return edVerify(null, message, key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/** Sign a project config, producing a verifiable envelope. */
export async function signProject(
  key: SigningKey,
  project: ProjectId,
  revision: number,
  config: ProjectConfig,
): Promise<ProjectEnvelope> {
  const body: EnvelopeBody = {
    envelopeVersion: ENVELOPE_VERSION,
    project,
    revision,
    signer: key.deviceId,
    hash: hashConfig(config),
  };
  const signature = await key.sign(canonicalBytes(envelopeBodyJson(body)));
  return { ...body, signature };
}

/** Sign a trust registry document. */
export async function signTrustRegistry(
  key: SigningKey,
  revision: number,
  entries: readonly TrustEntry[],
): Promise<TrustRegistry> {
  const body: TrustRegistryBody = {
    registryVersion: TRUST_REGISTRY_VERSION,
    revision,
    signer: key.deviceId,
    entries,
  };
  const signature = await key.sign(canonicalBytes(registryBodyJson(body)));
  return { ...body, signature };
}

/**
 * Verify the trust registry's own signature. The registry is self-describing:
 * its signer must appear in its own entries as `trusted` with a public key that
 * validates the signature. This bootstraps trust from a device the operator has
 * chosen to seed.
 */
export function verifyTrustRegistry(registry: TrustRegistry): void {
  if (registry.registryVersion !== TRUST_REGISTRY_VERSION) {
    throw new VerificationError("Unsupported registry version", "malformed");
  }
  const signerEntry = registry.entries.find((e) => e.deviceId === registry.signer);
  if (!signerEntry) {
    throw new VerificationError("Registry signer not present in entries", "unknown-signer");
  }
  if (signerEntry.role !== "trusted") {
    throw new VerificationError("Registry signer is not trusted", "revoked-signer");
  }
  if (deviceIdFromPublicKey(signerEntry.publicKeyHex) !== signerEntry.deviceId) {
    throw new VerificationError("Registry signer id/key mismatch", "malformed");
  }
  const body = registryBodyJson({
    registryVersion: registry.registryVersion,
    revision: registry.revision,
    signer: registry.signer,
    entries: registry.entries,
  });
  if (!verifyEd25519(signerEntry.publicKeyHex, canonicalBytes(body), registry.signature)) {
    throw new VerificationError("Registry signature invalid", "bad-signature");
  }
}

export interface VerifyOptions {
  /** Last successfully applied revision for this project, or 0/undefined if none. */
  readonly lastAppliedRevision?: number;
}

export interface VerifiedProject {
  readonly project: ProjectId;
  readonly revision: number;
  readonly signer: string;
  readonly config: ProjectConfig;
}

/**
 * Verify a project envelope against a (pre-verified) trust registry and the
 * presented config. Enforces, in order: registry membership + role, id/key
 * binding, hash match, signature, and rollback protection.
 */
export function verifyProject(
  envelope: ProjectEnvelope,
  config: ProjectConfig,
  registry: TrustRegistry,
  options: VerifyOptions = {},
): VerifiedProject {
  if (envelope.envelopeVersion !== ENVELOPE_VERSION) {
    throw new VerificationError("Unsupported envelope version", "malformed");
  }
  if (envelope.project !== config.id) {
    throw new VerificationError("Envelope project does not match config id", "malformed");
  }
  const entry = registry.entries.find((e) => e.deviceId === envelope.signer);
  if (!entry) {
    throw new VerificationError(`Unknown signer ${envelope.signer}`, "unknown-signer");
  }
  if (entry.role === "revoked") {
    throw new VerificationError(`Signer ${envelope.signer} is revoked`, "revoked-signer");
  }
  if (deviceIdFromPublicKey(entry.publicKeyHex) !== entry.deviceId) {
    throw new VerificationError("Signer id/key mismatch", "malformed");
  }
  const expectedHash = hashConfig(config);
  if (envelope.hash !== expectedHash) {
    throw new VerificationError("Config hash does not match envelope", "hash-mismatch");
  }
  const body = envelopeBodyJson({
    envelopeVersion: envelope.envelopeVersion,
    project: envelope.project,
    revision: envelope.revision,
    signer: envelope.signer,
    hash: envelope.hash,
  });
  if (!verifyEd25519(entry.publicKeyHex, canonicalBytes(body), envelope.signature)) {
    throw new VerificationError("Envelope signature invalid", "bad-signature");
  }
  const last = options.lastAppliedRevision ?? 0;
  if (envelope.revision <= last) {
    throw new VerificationError(
      `Rollback: revision ${envelope.revision} <= last applied ${last}`,
      "rollback",
    );
  }
  return {
    project: envelope.project,
    revision: envelope.revision,
    signer: envelope.signer,
    config,
  };
}

export interface QuarantineDecision {
  readonly accepted: boolean;
  readonly verified?: VerifiedProject;
  readonly error?: VerificationError;
}

/**
 * Non-throwing wrapper: returns a decision. On any verification failure the
 * config is quarantined (accepted=false) with the error attached, so callers
 * can keep running the last good config rather than crashing.
 */
export function evaluateProject(
  envelope: ProjectEnvelope,
  config: ProjectConfig,
  registry: TrustRegistry,
  options: VerifyOptions = {},
): QuarantineDecision {
  try {
    const verified = verifyProject(envelope, config, registry, options);
    return { accepted: true, verified };
  } catch (err) {
    if (err instanceof VerificationError) {
      return { accepted: false, error: err };
    }
    throw err;
  }
}
