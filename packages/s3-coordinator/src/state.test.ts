import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeProfileId,
  stateKey,
  parseStateKey,
  revisionKey,
  capabilityKey,
  encodeState,
  decodeState,
  initialState,
  MAX_STATE_BYTES,
  type ProfileState,
} from "./state.js";
import { StoreError, StoreErrorKind } from "./store.js";

test("assertSafeProfileId: accepts url-safe ids", () => {
  for (const id of ["abc", "profile-1", "a.b_c-2", "A1", "0"]) {
    assert.doesNotThrow(() => assertSafeProfileId(id));
  }
});

test("assertSafeProfileId: rejects path traversal and unsafe chars", () => {
  const bad = ["", "..", "../etc", "a/b", "a\\b", ".hidden", "a b", "a..b", "/abs", "a%2e%2e"];
  for (const id of bad) {
    assert.throws(
      () => assertSafeProfileId(id),
      (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
      `expected reject: ${JSON.stringify(id)}`,
    );
  }
});

test("stateKey: builds a stable, prefix-contained key", () => {
  assert.equal(stateKey("control", "p1"), "control/profiles/p1/state.json");
  assert.equal(stateKey("/control/", "p1"), "control/profiles/p1/state.json");
  assert.equal(stateKey("a/b", "p1"), "a/b/profiles/p1/state.json");
});

test("stateKey: refuses traversal profile id", () => {
  assert.throws(() => stateKey("control", "../../x"));
});

test("revisionKey: sanitizes operationId and bounds it", () => {
  assert.equal(revisionKey("control", 3, "op-1"), "control/revisions/3-op-1.json");
  const k = revisionKey("control", 5, "a/../b*c");
  assert.match(k, /^control\/revisions\/5-[A-Za-z0-9._-]+\.json$/);
  assert.ok(!k.includes(".."));
});

test("revisionKey: rejects negative/non-integer revision", () => {
  assert.throws(() => revisionKey("control", -1, "op"));
  assert.throws(() => revisionKey("control", 1.5, "op"));
});

test("capabilityKey: requires url-safe token", () => {
  assert.equal(capabilityKey("control", "abc-1"), "control/capabilities/abc-1.json");
  assert.throws(() => capabilityKey("control", "a/b"));
});

test("encode/decode round-trips a valid state", () => {
  const s = initialState("p1");
  s.currentRevision = 7;
  s.ownerDeviceId = "dev-a";
  s.leaseId = "lease-1";
  s.leaseExpiresAt = 123456;
  s.fencingToken = 4;
  const decoded = decodeState(encodeState(s), "p1");
  assert.deepEqual(decoded, s);
});

test("decodeState: rejects wrong profileId (key mismatch)", () => {
  const s = initialState("p1");
  assert.throws(
    () => decodeState(encodeState(s), "p2"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
  );
});

test("decodeState: rejects malformed JSON, non-object, bad version", () => {
  const enc = new TextEncoder();
  assert.throws(() => decodeState(enc.encode("not json"), "p1"));
  assert.throws(() => decodeState(enc.encode("[]"), "p1"));
  assert.throws(() => decodeState(enc.encode(JSON.stringify({ version: 2 })), "p1"));
});

test("decodeState: rejects bad field types", () => {
  const base = initialState("p1") as unknown as Record<string, unknown>;
  const enc = new TextEncoder();
  const mutate = (patch: Record<string, unknown>) =>
    decodeState(enc.encode(JSON.stringify({ ...base, ...patch })), "p1");
  assert.throws(() => mutate({ currentRevision: -1 }));
  assert.throws(() => mutate({ currentRevision: "x" }));
  assert.throws(() => mutate({ fencingToken: 2.2 }));
  assert.throws(() => mutate({ ownerDeviceId: 5 }));
  assert.throws(() => mutate({ leaseExpiresAt: -3 }));
  assert.throws(() => mutate({ updatedAt: 123 }));
  assert.throws(() => mutate({ lastOperation: { kind: "nope" } }));
});

test("decodeState: rejects oversized documents", () => {
  const enc = new TextEncoder();
  const huge = new Uint8Array(MAX_STATE_BYTES + 1);
  assert.throws(
    () => decodeState(huge, "p1"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
  );
});

test("encodeState: rejects oversized state via giant snapshot id", () => {
  const s: ProfileState = initialState("p1");
  s.latestSnapshotId = "x".repeat(MAX_STATE_BYTES + 10);
  assert.throws(
    () => encodeState(s),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
  );
});

// ── v1 backward-compatible decode ────────────────────────────────────────────

test("decodeState: accepts a v1 document, defaulting generation=0 and tombstone=null", () => {
  const enc = new TextEncoder();
  const v1 = {
    version: 1,
    profileId: "p1",
    currentRevision: 3,
    latestSnapshotId: "snap",
    ownerDeviceId: "dev-a",
    leaseId: "lease-1",
    leaseExpiresAt: 12345,
    fencingToken: 2,
    updatedAt: new Date(0).toISOString(),
    updatedByDeviceId: "dev-a",
    lastOperation: null,
  };
  const decoded = decodeState(enc.encode(JSON.stringify(v1)), "p1");
  assert.equal(decoded.version, 1);
  assert.equal(decoded.generation, 0);
  assert.equal(decoded.tombstone, null);
  assert.equal(decoded.currentRevision, 3);
});

test("decodeState: still rejects unknown versions (v3), fails closed", () => {
  const enc = new TextEncoder();
  assert.throws(
    () => decodeState(enc.encode(JSON.stringify({ version: 3, profileId: "p1" })), "p1"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
  );
});

// ── v2 tombstone decode ──────────────────────────────────────────────────────

test("decodeState: round-trips a v2 tombstoned state", () => {
  const s = initialState("p1");
  s.generation = 4;
  s.tombstone = {
    generation: 4,
    deletedByDeviceId: "dev-a",
    deletedAt: new Date(0).toISOString(),
    operationId: "op-del",
    reason: "user requested",
  };
  const decoded = decodeState(encodeState(s), "p1");
  assert.deepEqual(decoded, s);
  assert.equal(decoded.tombstone?.generation, 4);
});

test("decodeState: rejects malformed tombstone", () => {
  const base = initialState("p1") as unknown as Record<string, unknown>;
  const enc = new TextEncoder();
  const mutate = (patch: Record<string, unknown>) =>
    decodeState(enc.encode(JSON.stringify({ ...base, version: 2, ...patch })), "p1");
  assert.throws(() => mutate({ tombstone: { generation: -1, deletedByDeviceId: "d", deletedAt: "t", operationId: "o", reason: null } }));
  assert.throws(() => mutate({ tombstone: { generation: 1, deletedByDeviceId: 5, deletedAt: "t", operationId: "o", reason: null } }));
  assert.throws(() => mutate({ tombstone: "x" }));
  assert.throws(() => mutate({ generation: "nope" }));
});

// ── parseStateKey (whole-library discovery filter) ───────────────────────────

test("parseStateKey: returns profileId only for exact state.json keys", () => {
  assert.equal(parseStateKey("control", "control/profiles/p1/state.json"), "p1");
  assert.equal(parseStateKey("/control/", "control/profiles/a.b_c-2/state.json"), "a.b_c-2");
});

test("parseStateKey: ignores capability/history/probe/nested/unsafe keys", () => {
  const bad = [
    "control/capabilities/tok.json",
    "control/revisions/1-op.json",
    "control/profiles/p1/probes/x.json",
    "control/profiles/p1/history/2.json",
    "control/profiles/p1/nested/state.json",
    "control/profiles/state.json", // no id segment
    "control/profiles//state.json", // empty id
    "control/profiles/../state.json", // traversal id
    "control/profiles/p1/state.jsonx", // wrong suffix
    "control/profiles/p1/other.json",
    "other/profiles/p1/state.json", // wrong prefix
  ];
  for (const k of bad) {
    assert.equal(parseStateKey("control", k), null, `expected null for ${k}`);
  }
});
