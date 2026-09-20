import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLease, isFencingTokenValid, isLeaseExpired } from "./decisions.js";
import type { Lease, ProfileCoordinationState, LeaseRequest } from "./types.js";

function coord(over: Partial<ProfileCoordinationState> = {}): ProfileCoordinationState {
  return {
    profileId: "p1",
    currentRevision: 5,
    latestSnapshotId: "snap-5",
    ownerDeviceId: null,
    leaseExpiresAtMs: null,
    fencingToken: 3,
    updatedAtMs: 0,
    updatedByDeviceId: null,
    handoffTargetDeviceId: null,
    ...over,
  };
}

const req = (over: Partial<LeaseRequest> = {}): LeaseRequest => ({
  profileId: "p1",
  deviceId: "dev-A",
  durationMs: 45_000,
  ...over,
});

test("evaluateLease: free lease → granted with incremented fencing token", () => {
  const d = evaluateLease(coord({ ownerDeviceId: null, leaseExpiresAtMs: null }), req(), 1_000);
  assert.equal(d.kind, "granted");
  if (d.kind === "granted") {
    assert.equal(d.lease.ownerDeviceId, "dev-A");
    assert.equal(d.lease.fencingToken, 4); // 3 + 1
    assert.equal(d.lease.expiresAtMs, 46_000);
  }
});

test("evaluateLease: expired lease held by other → granted (takeover), token bumps", () => {
  const d = evaluateLease(
    coord({ ownerDeviceId: "dev-B", leaseExpiresAtMs: 500, fencingToken: 7 }),
    req({ deviceId: "dev-A" }),
    1_000,
  );
  assert.equal(d.kind, "granted");
  if (d.kind === "granted") {
    assert.equal(d.lease.ownerDeviceId, "dev-A");
    assert.equal(d.lease.fencingToken, 8);
  }
});

test("evaluateLease: same owner renewing → renewed, token unchanged (same epoch)", () => {
  const d = evaluateLease(
    coord({ ownerDeviceId: "dev-A", leaseExpiresAtMs: 5_000, fencingToken: 7 }),
    req({ deviceId: "dev-A" }),
    1_000,
  );
  assert.equal(d.kind, "renewed");
  if (d.kind === "renewed") {
    assert.equal(d.lease.fencingToken, 7);
    assert.equal(d.lease.expiresAtMs, 46_000);
  }
});

test("evaluateLease: active lease held by other → denied", () => {
  const d = evaluateLease(
    coord({ ownerDeviceId: "dev-B", leaseExpiresAtMs: 9_000, fencingToken: 7 }),
    req({ deviceId: "dev-A" }),
    1_000,
  );
  assert.equal(d.kind, "denied");
  if (d.kind === "denied") {
    assert.equal(d.ownerDeviceId, "dev-B");
    assert.equal(d.expiresAtMs, 9_000);
  }
});

test("evaluateLease: boundary — lease expiring exactly at now is treated expired", () => {
  const d = evaluateLease(
    coord({ ownerDeviceId: "dev-B", leaseExpiresAtMs: 1_000, fencingToken: 2 }),
    req({ deviceId: "dev-A" }),
    1_000,
  );
  assert.equal(d.kind, "granted");
});

test("isFencingTokenValid: equal or greater accepted, smaller rejected", () => {
  assert.ok(isFencingTokenValid(5, 5));
  assert.ok(isFencingTokenValid(5, 6));
  assert.ok(!isFencingTokenValid(5, 4));
});

test("isLeaseExpired: null lease is expired", () => {
  assert.ok(isLeaseExpired(null, 1_000));
});

test("isLeaseExpired: expiry at now counts as expired", () => {
  const lease: Lease = {
    profileId: "p1",
    ownerDeviceId: "dev-A",
    expiresAtMs: 1_000,
    fencingToken: 1,
  };
  assert.ok(isLeaseExpired(lease, 1_000));
  assert.ok(!isLeaseExpired(lease, 999));
});
