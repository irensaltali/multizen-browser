import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncErrorCode, syncError, isSyncError } from "./errors.js";

test("SyncErrorCode: string values equal member names (stable serialization)", () => {
  for (const [name, value] of Object.entries(SyncErrorCode)) {
    assert.equal(value, name, `enum member ${name} must serialize to itself`);
  }
});

test("SyncErrorCode: expected members exist and are unique", () => {
  const expected = [
    "SyncDisabled",
    "StorageUnreachable",
    "StorageAuthFailed",
    "LeaseHeldByOther",
    "LeaseFenced",
    "LeaseExpired",
    "ConflictDetected",
    "BrowserStillRunning",
    "RevisionNotFound",
    "LocalStateCorrupt",
    "SnapshotIntegrityFailed",
    "PublishRejected",
    "InvalidInput",
    "Internal",
  ];
  const values = Object.values(SyncErrorCode);
  for (const e of expected) assert.ok(values.includes(e as SyncErrorCode), `missing ${e}`);
  assert.equal(new Set(values).size, values.length, "no duplicate values");
  assert.equal(values.length, expected.length, "no unexpected extra members");
});

test("syncError: omits details when not provided", () => {
  const e = syncError(SyncErrorCode.Internal, "boom");
  assert.deepEqual(e, { code: SyncErrorCode.Internal, message: "boom" });
  assert.ok(!("details" in e));
});

test("syncError: includes details when provided", () => {
  const e = syncError(SyncErrorCode.ConflictDetected, "x", { a: 1 });
  assert.deepEqual(e.details, { a: 1 });
});

test("isSyncError: accepts valid, rejects invalid", () => {
  assert.ok(isSyncError(syncError(SyncErrorCode.Internal, "m")));
  assert.ok(!isSyncError(null));
  assert.ok(!isSyncError({ code: "NotACode", message: "m" }));
  assert.ok(!isSyncError({ code: SyncErrorCode.Internal }));
  assert.ok(!isSyncError({ message: "m" }));
});
