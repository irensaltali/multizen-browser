import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncErrorCode } from "@multizen/sync-core";
import { InMemoryConditionalObjectStore } from "./inMemoryStore.js";
import { S3Coordinator, type S3CoordinatorConfig } from "./coordinator.js";
import { StoreErrorKind } from "./store.js";
import { stateKey } from "./state.js";

const PREFIX = "control";
const TTL = 60_000;
const SKEW = 10_000;

function mk(
  store: InMemoryConditionalObjectStore,
  deviceId: string,
  extra: Partial<S3CoordinatorConfig> = {},
): S3Coordinator {
  return new S3Coordinator(store, {
    deviceId,
    controlPrefix: PREFIX,
    leaseTtlMs: TTL,
    renewalMs: 15_000,
    clockSkewSafetyMs: SKEW,
    maxCasRetries: 8,
    ...extra,
  });
}

function isSyncCode(code: SyncErrorCode) {
  return (e: unknown) =>
    typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;
}

test("getState: not-found → revision 0 sentinel", async () => {
  const store = new InMemoryConditionalObjectStore();
  const c = mk(store, "dev-a");
  const r = await c.getState("p1");
  assert.equal(r.kind, "not-found");
});

test("health delegates to store", async () => {
  const store = new InMemoryConditionalObjectStore();
  const c = mk(store, "dev-a");
  assert.equal(await c.health(), true);
  store.setHealthy(false);
  assert.equal(await c.health(), false);
});

test("acquire: first acquisition creates state, grants lease, fencing=1", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = mk(store, "dev-a");
  const res = await c.acquire("p1", "op-1");
  assert.equal(res.state.ownerDeviceId, "dev-a");
  assert.equal(res.state.currentRevision, 0);
  assert.equal(res.lease.fencingToken, 1);
  assert.equal(res.lease.leaseExpiresAt, 1_000_000 + TTL);
  assert.ok(res.lease.leaseId.length > 0);
  // state object exists and is authoritative
  assert.ok(store.has(stateKey(PREFIX, "p1")));
});

test("acquire: active other-owner is denied (LeaseHeldByOther)", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  await a.acquire("p1", "op-a");
  await assert.rejects(() => b.acquire("p1", "op-b"), isSyncCode(SyncErrorCode.LeaseHeldByOther));
});

test("acquire: expired lease within skew margin cannot be taken over", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  const lease = await a.acquire("p1", "op-a");
  // move just past expiry but within skew margin
  store.setNow(lease.lease.leaseExpiresAt + SKEW - 1);
  await assert.rejects(() => b.acquire("p1", "op-b"), isSyncCode(SyncErrorCode.LeaseHeldByOther));
});

test("acquire: expired lease takeover past skew margin increments fencing", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  const first = await a.acquire("p1", "op-a");
  store.setNow(first.lease.leaseExpiresAt + SKEW); // exactly at threshold
  const takeover = await b.acquire("p1", "op-b");
  assert.equal(takeover.state.ownerDeviceId, "dev-b");
  assert.equal(takeover.lease.fencingToken, first.lease.fencingToken + 1);
});

test("acquire: same-device reacquire creates fresh lease + increments fencing", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const first = await a.acquire("p1", "op-1");
  const second = await a.acquire("p1", "op-2");
  assert.equal(second.state.ownerDeviceId, "dev-a");
  assert.equal(second.lease.fencingToken, first.lease.fencingToken + 1);
  assert.notEqual(second.lease.leaseId, first.lease.leaseId);
});

test("acquire idempotency: same operationId replays without new fencing", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const first = await a.acquire("p1", "op-1");
  const replay = await a.acquire("p1", "op-1");
  assert.equal(replay.lease.fencingToken, first.lease.fencingToken);
  assert.equal(replay.lease.leaseId, first.lease.leaseId);
});

test("renew: requires exact owner+lease+fencing and unexpired lease", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  store.advance(1000);
  const renewed = await a.renew("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-renew");
  assert.equal(renewed.lease.fencingToken, lease.lease.fencingToken, "renew keeps epoch");
  assert.equal(renewed.lease.leaseExpiresAt, store.now() + TTL);
});

test("renew: wrong lease id → LeaseHeldByOther; wrong fencing → LeaseFenced", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  await assert.rejects(
    () => a.renew("p1", "wrong-lease", lease.lease.fencingToken, "op-x"),
    isSyncCode(SyncErrorCode.LeaseHeldByOther),
  );
  await assert.rejects(
    () => a.renew("p1", lease.lease.leaseId, lease.lease.fencingToken + 5, "op-y"),
    isSyncCode(SyncErrorCode.LeaseFenced),
  );
});

test("renew: expired lease → LeaseExpired", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  store.setNow(lease.lease.leaseExpiresAt + 1);
  await assert.rejects(
    () => a.renew("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-x"),
    isSyncCode(SyncErrorCode.LeaseExpired),
  );
});

test("stale-owner after takeover: renew fails deterministically (LeaseHeldByOther)", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  const first = await a.acquire("p1", "op-a");
  store.setNow(first.lease.leaseExpiresAt + SKEW);
  await b.acquire("p1", "op-b"); // takeover
  // dev-a wakes up and tries to renew with its old lease — must fail.
  await assert.rejects(
    () => a.renew("p1", first.lease.leaseId, first.lease.fencingToken, "op-late"),
    isSyncCode(SyncErrorCode.LeaseHeldByOther),
  );
});

test("publish: requires expectedRevision, bumps revision exactly once, renews expiry", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  store.advance(5_000);
  const pub = await a.publish("p1", {
    leaseId: lease.lease.leaseId,
    fencingToken: lease.lease.fencingToken,
    operationId: "op-pub",
    expectedRevision: 0,
    latestSnapshotId: "snap-1",
  });
  assert.equal(pub.revision, 1);
  assert.equal(pub.state.currentRevision, 1);
  assert.equal(pub.state.latestSnapshotId, "snap-1");
  assert.equal(pub.state.leaseExpiresAt, store.now() + TTL, "publish renews expiry");
  assert.equal(pub.historyWarning, undefined);
  // history record written
  const revKeys = store.keys().filter((k) => k.startsWith("control/revisions/"));
  assert.equal(revKeys.length, 1);
});

test("publish: wrong expectedRevision → PublishRejected", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  await assert.rejects(
    () =>
      a.publish("p1", {
        leaseId: lease.lease.leaseId,
        fencingToken: lease.lease.fencingToken,
        operationId: "op-pub",
        expectedRevision: 5,
        latestSnapshotId: "snap-1",
      }),
    isSyncCode(SyncErrorCode.PublishRejected),
  );
});

test("publish idempotency: replay same operationId does not bump twice", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  const args = {
    leaseId: lease.lease.leaseId,
    fencingToken: lease.lease.fencingToken,
    operationId: "op-pub",
    expectedRevision: 0,
    latestSnapshotId: "snap-1",
  };
  const first = await a.publish("p1", args);
  const replay = await a.publish("p1", args);
  assert.equal(first.revision, 1);
  assert.equal(replay.revision, 1, "replay returns accepted revision, no re-increment");
  assert.equal(replay.state.currentRevision, 1);
});

test("publish: history write failure returns warning but state CAS succeeds", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  // Fail the immutable history put (revisions/*), but not the state CAS.
  store.injectFault({
    op: "put",
    keyMatch: (k) => k.startsWith("control/revisions/"),
    kind: StoreErrorKind.Unreachable,
  });
  const pub = await a.publish("p1", {
    leaseId: lease.lease.leaseId,
    fencingToken: lease.lease.fencingToken,
    operationId: "op-pub",
    expectedRevision: 0,
    latestSnapshotId: "snap-1",
  });
  assert.equal(pub.revision, 1, "state advanced despite history failure");
  assert.ok(pub.historyWarning, "history warning present");
});

test("release: clears ownership, keeps state object (never deletes), idempotent", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  const rel = await a.release("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-rel");
  assert.equal(rel.released, true);
  assert.equal(rel.state.ownerDeviceId, null);
  assert.ok(store.has(stateKey(PREFIX, "p1")), "state object still present after release");
  // idempotent replay
  const replay = await a.release("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-rel");
  assert.equal(replay.released, true);
});

test("no-ABA: after release, fencing keeps increasing on next acquire", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  const first = await a.acquire("p1", "op-a1");
  await a.release("p1", first.lease.leaseId, first.lease.fencingToken, "op-r1");
  const next = await b.acquire("p1", "op-b1");
  assert.ok(next.lease.fencingToken > first.lease.fencingToken, "fencing monotonic across release");
});

test("revision monotonic across multiple publishes", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  const p1 = await a.publish("p1", {
    leaseId: lease.lease.leaseId,
    fencingToken: lease.lease.fencingToken,
    operationId: "op-p1",
    expectedRevision: 0,
    latestSnapshotId: "s1",
  });
  const p2 = await a.publish("p1", {
    leaseId: lease.lease.leaseId,
    fencingToken: lease.lease.fencingToken,
    operationId: "op-p2",
    expectedRevision: p1.revision,
    latestSnapshotId: "s2",
  });
  assert.equal(p1.revision, 1);
  assert.equal(p2.revision, 2);
});
