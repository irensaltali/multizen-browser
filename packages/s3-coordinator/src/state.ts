/**
 * Persistent per-profile coordination state and its (de)serialization.
 *
 * There is exactly ONE state object per profile, stored at
 * `<controlPrefix>/profiles/<safeId>/state.json`. It is created once (with a
 * conditional `If-None-Match: *` create) and thereafter only ever CAS-updated.
 * It is NEVER deleted — release clears ownership fields but keeps the object so
 * the revision line and idempotency record survive.
 *
 * Every field decoded from storage is validated for type, range, and size.
 * Malformed or oversized state is rejected (`StoreError.Malformed`) rather than
 * trusted, so a corrupt or hostile object can never drive the coordinator into
 * an inconsistent lease/revision decision.
 */

import { StoreError, StoreErrorKind } from "./store.js";

/**
 * Current schema version written by this coordinator.
 *
 * v2 adds durable `generation` + `tombstone` fields (see {@link ProfileState}).
 * The decoder still accepts v1 documents (defaulting the new fields), so an
 * upgraded coordinator reads state written by an older one transparently.
 *
 * IMPORTANT — fail-closed for old clients: a v1-only client's decoder rejects
 * any `version !== 1` document as `Malformed`. Because a TOMBSTONE is always
 * written at schema v2, an old client that reads a tombstoned profile's
 * `state.json` fails to decode it and therefore refuses to coordinate against
 * it (it cannot acquire/renew/publish). This is intentional: a stale peer that
 * predates tombstone semantics must never treat a deleted profile as live.
 */
export const STATE_VERSION = 2 as const;

/** All schema versions this decoder understands. */
export type StateVersion = 1 | 2;

/** Hard cap on the serialized state document size (defensive). */
export const MAX_STATE_BYTES = 64 * 1024;

/** Max length of ids/tokens we accept from storage (defensive). */
const MAX_ID_LEN = 512;

/**
 * Bounded record of the last accepted mutating operation, enabling idempotent
 * retries: replaying the same `operationId` reconstructs the accepted result
 * without incrementing revision/fencing again. One latest operation is
 * sufficient for the MVP.
 */
export interface LastOperation {
  /** Caller-supplied idempotency key for the operation. */
  operationId: string;
  /** Which mutating verb produced this record. */
  kind: "acquire" | "renew" | "publish" | "release" | "tombstone" | "revive";
  /** Revision in effect after the operation completed. */
  revision: number;
  /** Fencing token in effect after the operation completed. */
  fencingToken: number;
  /** Lease id in effect after the operation (empty string when released). */
  leaseId: string;
  /** Lease expiry (epoch ms) after the operation, or null when released. */
  leaseExpiresAt: number | null;
  /** Snapshot id recorded by a publish, else null. */
  latestSnapshotId: string | null;
}

/**
 * Durable deletion marker. Its presence (non-null {@link ProfileState.tombstone})
 * means the profile is DELETED at the recorded generation. A tombstone is
 * authoritative and minimal — it records who deleted it, when, and at which
 * generation — and is NEVER itself deleted. Reviving a profile clears the
 * tombstone but MUST bump {@link ProfileState.generation}, fencing any peer
 * that still holds a lease/token from before the deletion.
 */
export interface Tombstone {
  /** Generation at which the profile was tombstoned. */
  generation: number;
  /** Device that recorded the tombstone. */
  deletedByDeviceId: string;
  /** ISO-8601 timestamp of the tombstone. */
  deletedAt: string;
  /** Idempotency key of the tombstone operation. */
  operationId: string;
  /** Optional non-secret human-readable reason. */
  reason: string | null;
}

/** The authoritative, persisted coordination state for a single profile. */
export interface ProfileState {
  version: StateVersion;
  profileId: string;
  /**
   * Monotonic generation counter. Starts at 0. A tombstone/revive bumps it so
   * that a fresh revision line begins and stale peers holding fencing tokens
   * from an earlier generation are fenced out. (Fencing tokens are only
   * comparable WITHIN a generation.)
   */
  generation: number;
  currentRevision: number;
  latestSnapshotId: string | null;
  ownerDeviceId: string | null;
  leaseId: string | null;
  /** Epoch ms at which the current lease expires, or null when unowned. */
  leaseExpiresAt: number | null;
  fencingToken: number;
  /** ISO-8601 timestamp of the last mutation. */
  updatedAt: string;
  updatedByDeviceId: string | null;
  /** Bounded idempotency record of the most recent mutation, if any. */
  lastOperation: LastOperation | null;
  /**
   * Non-null iff the profile is currently DELETED. When set, the coordinator
   * blocks acquire/renew/publish for this profile until it is revived.
   */
  tombstone: Tombstone | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Validate a profile id for use inside an object key. Rejects anything that
 * could escape the intended prefix (path traversal) or produce an ambiguous
 * key. Allowed: letters, digits, `-`, `_`, `.` — but never `..`, never a
 * leading dot, never a slash. Bounded length.
 */
export function assertSafeProfileId(profileId: string): void {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new StoreError(StoreErrorKind.Malformed, "profileId must be a non-empty string");
  }
  if (profileId.length > 256) {
    throw new StoreError(StoreErrorKind.Malformed, "profileId too long");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileId)) {
    throw new StoreError(
      StoreErrorKind.Malformed,
      "profileId contains characters not allowed in an object key",
    );
  }
  if (profileId.includes("..")) {
    throw new StoreError(StoreErrorKind.Malformed, "profileId must not contain '..'");
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Object key for a profile's single persistent state document. */
export function stateKey(controlPrefix: string, profileId: string): string {
  assertSafeProfileId(profileId);
  const p = normalizePrefix(controlPrefix);
  return `${p}/profiles/${profileId}/state.json`;
}

/** The object-key prefix under which per-profile state documents live. */
export function profilesPrefix(controlPrefix: string): string {
  return `${normalizePrefix(controlPrefix)}/profiles/`;
}

/**
 * Parse a `<controlPrefix>/profiles/<safeId>/state.json` key back to its
 * profileId. Returns null for ANY key that is not EXACTLY a state document for
 * a safe profile id: capability/history/probe keys, nested keys, keys with
 * extra path segments, or keys whose id is unsafe (traversal, slashes, etc.).
 *
 * This is the strict filter used by whole-library discovery: only exact
 * state.json keys are considered, everything else is ignored.
 */
export function parseStateKey(controlPrefix: string, key: string): string | null {
  const prefix = profilesPrefix(controlPrefix);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  // rest must be exactly `<safeId>/state.json` — one segment then the file.
  const suffix = "/state.json";
  if (!rest.endsWith(suffix)) return null;
  const id = rest.slice(0, rest.length - suffix.length);
  if (id.length === 0) return null;
  // No further path separators are allowed (no nested profiles/subpaths).
  if (id.includes("/")) return null;
  try {
    assertSafeProfileId(id);
  } catch {
    return null;
  }
  return id;
}

/** Object key for an immutable revision (history) record. */
export function revisionKey(controlPrefix: string, revision: number, operationId: string): string {
  const p = normalizePrefix(controlPrefix);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new StoreError(StoreErrorKind.Malformed, "revision must be a non-negative integer");
  }
  const safeOp = sanitizeOperationIdForKey(operationId);
  return `${p}/revisions/${revision}-${safeOp}.json`;
}

/** Object key for a unique capability-probe object. */
export function capabilityKey(controlPrefix: string, token: string): string {
  const p = normalizePrefix(controlPrefix);
  if (!/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new StoreError(StoreErrorKind.Malformed, "capability token must be url-safe");
  }
  return `${p}/capabilities/${token}.json`;
}

/** Reduce an operationId to a key-safe slug (bounded, no traversal). */
function sanitizeOperationIdForKey(operationId: string): string {
  const slug = String(operationId)
    .replace(/[^A-Za-z0-9_-]/g, "_") // drop dots and everything non-url-safe
    .slice(0, 128);
  return slug.length > 0 ? slug : "op";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkIdField(name: string, v: unknown, nullable: boolean): string | null {
  if (v === null) {
    if (nullable) return null;
    throw new StoreError(StoreErrorKind.Malformed, `${name} must not be null`);
  }
  if (typeof v !== "string") {
    throw new StoreError(StoreErrorKind.Malformed, `${name} must be a string`);
  }
  if (v.length > MAX_ID_LEN) {
    throw new StoreError(StoreErrorKind.Malformed, `${name} exceeds max length`);
  }
  return v;
}

function checkFiniteInt(name: string, v: unknown, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new StoreError(StoreErrorKind.Malformed, `${name} must be an integer >= ${min}`);
  }
  return v;
}

function checkExpiry(name: string, v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new StoreError(StoreErrorKind.Malformed, `${name} must be a non-negative number or null`);
  }
  return v;
}

function decodeLastOperation(v: unknown): LastOperation | null {
  if (v === null || v === undefined) return null;
  if (!isPlainObject(v)) {
    throw new StoreError(StoreErrorKind.Malformed, "lastOperation must be an object or null");
  }
  const kind = v.kind;
  if (
    kind !== "acquire" &&
    kind !== "renew" &&
    kind !== "publish" &&
    kind !== "release" &&
    kind !== "tombstone" &&
    kind !== "revive"
  ) {
    throw new StoreError(StoreErrorKind.Malformed, "lastOperation.kind invalid");
  }
  const operationId = checkIdField("lastOperation.operationId", v.operationId, false) as string;
  const revision = checkFiniteInt("lastOperation.revision", v.revision, 0);
  const fencingToken = checkFiniteInt("lastOperation.fencingToken", v.fencingToken, 0);
  const leaseId = checkIdField("lastOperation.leaseId", v.leaseId, false) as string;
  const leaseExpiresAt = checkExpiry("lastOperation.leaseExpiresAt", v.leaseExpiresAt);
  const latestSnapshotId = checkIdField(
    "lastOperation.latestSnapshotId",
    v.latestSnapshotId,
    true,
  );
  return { operationId, kind, revision, fencingToken, leaseId, leaseExpiresAt, latestSnapshotId };
}

function decodeTombstone(v: unknown): Tombstone | null {
  if (v === null || v === undefined) return null;
  if (!isPlainObject(v)) {
    throw new StoreError(StoreErrorKind.Malformed, "tombstone must be an object or null");
  }
  const generation = checkFiniteInt("tombstone.generation", v.generation, 0);
  const deletedByDeviceId = checkIdField("tombstone.deletedByDeviceId", v.deletedByDeviceId, false) as string;
  const deletedAt = checkIdField("tombstone.deletedAt", v.deletedAt, false) as string;
  const operationId = checkIdField("tombstone.operationId", v.operationId, false) as string;
  const reason = checkIdField("tombstone.reason", v.reason, true);
  return { generation, deletedByDeviceId, deletedAt, operationId, reason };
}

/** Serialize state to canonical JSON bytes, enforcing the size cap. */
export function encodeState(state: ProfileState): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(state));
  if (bytes.byteLength > MAX_STATE_BYTES) {
    throw new StoreError(StoreErrorKind.Malformed, "encoded state exceeds size cap");
  }
  return bytes;
}

/**
 * Decode and fully validate a state document from storage. Every field is
 * type/range/size-checked; anything unexpected rejects with `Malformed`.
 */
export function decodeState(bytes: Uint8Array, expectedProfileId: string): ProfileState {
  if (bytes.byteLength > MAX_STATE_BYTES) {
    throw new StoreError(StoreErrorKind.Malformed, "state document exceeds size cap");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new StoreError(StoreErrorKind.Malformed, "state document is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreError(StoreErrorKind.Malformed, "state document is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new StoreError(StoreErrorKind.Malformed, "state document must be a JSON object");
  }
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new StoreError(StoreErrorKind.Malformed, "unsupported state version");
  }
  const version = parsed.version as StateVersion;
  const profileId = checkIdField("profileId", parsed.profileId, false) as string;
  assertSafeProfileId(profileId);
  if (profileId !== expectedProfileId) {
    throw new StoreError(StoreErrorKind.Malformed, "state profileId does not match key");
  }
  const currentRevision = checkFiniteInt("currentRevision", parsed.currentRevision, 0);
  const latestSnapshotId = checkIdField("latestSnapshotId", parsed.latestSnapshotId, true);
  const ownerDeviceId = checkIdField("ownerDeviceId", parsed.ownerDeviceId, true);
  const leaseId = checkIdField("leaseId", parsed.leaseId, true);
  const leaseExpiresAt = checkExpiry("leaseExpiresAt", parsed.leaseExpiresAt);
  const fencingToken = checkFiniteInt("fencingToken", parsed.fencingToken, 0);
  const updatedAt = checkIdField("updatedAt", parsed.updatedAt, false) as string;
  const updatedByDeviceId = checkIdField("updatedByDeviceId", parsed.updatedByDeviceId, true);
  const lastOperation = decodeLastOperation(parsed.lastOperation);

  // v2 fields. When reading a v1 document these are absent: default
  // generation to 0 and tombstone to null (a v1 profile is never deleted).
  let generation: number;
  let tombstone: Tombstone | null;
  if (version === 2) {
    generation = checkFiniteInt("generation", parsed.generation, 0);
    tombstone = decodeTombstone(parsed.tombstone);
  } else {
    // v1: reject unexpected new fields being smuggled in, else default.
    if (parsed.generation !== undefined) {
      generation = checkFiniteInt("generation", parsed.generation, 0);
    } else {
      generation = 0;
    }
    tombstone = parsed.tombstone === undefined ? null : decodeTombstone(parsed.tombstone);
  }

  return {
    version,
    profileId,
    generation,
    currentRevision,
    latestSnapshotId,
    ownerDeviceId,
    leaseId,
    leaseExpiresAt,
    fencingToken,
    updatedAt,
    updatedByDeviceId,
    lastOperation,
    tombstone,
  };
}

/** The initial state for a never-seen profile (revision 0, unowned). */
export function initialState(profileId: string): ProfileState {
  assertSafeProfileId(profileId);
  return {
    version: STATE_VERSION,
    profileId,
    generation: 0,
    currentRevision: 0,
    latestSnapshotId: null,
    ownerDeviceId: null,
    leaseId: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    updatedAt: new Date(0).toISOString(),
    updatedByDeviceId: null,
    lastOperation: null,
    tombstone: null,
  };
}
