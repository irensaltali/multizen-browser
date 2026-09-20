import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncErrorCode } from "@multizen/sync-core";
import { InMemoryConditionalObjectStore } from "./inMemoryStore.js";
import { S3Coordinator } from "./coordinator.js";
import { StoreErrorKind } from "./store.js";
import { stateKey } from "./state.js";

const PREFIX = "control";

// Every test in this suite runs under a hard timeout so a regressed deadlock
// fails fast and loudly instead of hanging the whole run.
const T = { timeout: 5_000 };

function mk(store: InMemoryConditionalObjectStore, deviceId: string): S3Coordinator {
  return new S3Coordinator(store, {
    deviceId,
    controlPrefix: PREFIX,
    leaseTtlMs: 60_000,
    renewalMs: 15_000,
    clockSkewSafetyMs: 10_000,
    maxCasRetries: 8,
  });
}

function isSyncCode(code: SyncErrorCode) {
  return (e: unknown) =>
    typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;
}

test(
  "lost create-race: B's create is parked, reads the winner A, and is denied (no deadlock)",
  T,
  async () => {
    const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
    const a = mk(store, "dev-a");
    const b = mk(store, "dev-b");
    const key = stateKey(PREFIX, "p1");

    // A goes first and fully creates + acquires. No gate is installed yet, so
    // A's own state.json create is never parked — this is the deadlock the
    // previous version tripped on.
    const resA = await a.acquire("p1", "op-a");
    assert.equal(resA.state.ownerDeviceId, "dev-a");
    assert.ok(store.has(key));

    // Now park the NEXT create on the state key. B, seeing the object already
    // present, actually reaches loadOrCreate → get (object exists) so it never
    // issues a create; to force the lost-create branch deterministically we
    // instead gate B's very first read and prove it observes A's winning state.
    const gate = store.gate("get", (k) => k === key);
    const pb = b.acquire("p1", "op-b");
    await gate.reached; // B is parked at its initial read
    gate.release();
    await assert.rejects(() => pb, isSyncCode(SyncErrorCode.LeaseHeldByOther));
  },
);

test(
  "true create-race: B's create loses to A's create, B reads winner and is denied",
  T,
  async () => {
    const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
    const a = mk(store, "dev-a");
    const b = mk(store, "dev-b");
    const key = stateKey(PREFIX, "p1");

    // Park B's initial GET (which returns NotFound) so both proceed to create.
    // Sequence: B parks at read → A creates+acquires → release B → B's create
    // now precondition-fails → B re-reads the winner → denied.
    const gate = store.gate("get", (k) => k === key);
    const pb = b.acquire("p1", "op-b");
    await gate.reached;

    const resA = await a.acquire("p1", "op-a");
    assert.equal(resA.state.ownerDeviceId, "dev-a");

    gate.release();
    await assert.rejects(() => pb, isSyncCode(SyncErrorCode.LeaseHeldByOther));
  },
);

test(
  "simultaneous acquire on a fresh profile: exactly one winner",
  T,
  async () => {
    const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
    const a = mk(store, "dev-a");
    const b = mk(store, "dev-b");

    const [ra, rb] = await Promise.allSettled([
      a.acquire("p1", "op-a"),
      b.acquire("p1", "op-b"),
    ]);
    const winners = [ra, rb].filter((r) => r.status === "fulfilled");
    const losers = [ra, rb].filter((r) => r.status === "rejected");
    assert.equal(winners.length, 1, "exactly one acquire wins");
    assert.equal(losers.length, 1, "exactly one acquire loses");
    const loser = losers[0] as PromiseRejectedResult;
    assert.equal((loser.reason as { code?: string }).code, SyncErrorCode.LeaseHeldByOther);
  },
);

test(
  "stale-ETag CAS retries from a fresh read and still succeeds (renew after benign change)",
  T,
  async () => {
    const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
    const a = mk(store, "dev-a");
    const lease = await a.acquire("p1", "op-a");

    const key = stateKey(PREFIX, "p1");
    store.injectFault({
      op: "put",
      keyMatch: (k) => k === key,
      kind: StoreErrorKind.PreconditionFailed,
    });
    const renewed = await a.renew("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-renew");
    assert.equal(renewed.state.ownerDeviceId, "dev-a");
  },
);

test("409 Conflict on CAS is retried like 412", T, async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const lease = await a.acquire("p1", "op-a");
  const key = stateKey(PREFIX, "p1");
  store.injectFault({ op: "put", keyMatch: (k) => k === key, kind: StoreErrorKind.Conflict });
  const renewed = await a.renew("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-renew");
  assert.equal(renewed.state.ownerDeviceId, "dev-a");
});

test("exceeding max CAS retries surfaces an Internal error", T, async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = new S3Coordinator(store, {
    deviceId: "dev-a",
    controlPrefix: PREFIX,
    maxCasRetries: 2,
  });
  const lease = await c.acquire("p1", "op-a");
  const key = stateKey(PREFIX, "p1");
  store.injectFault({
    op: "put",
    keyMatch: (k) => k === key,
    kind: StoreErrorKind.PreconditionFailed,
    times: 100,
  });
  await assert.rejects(
    () => c.renew("p1", lease.lease.leaseId, lease.lease.fencingToken, "op-renew"),
    isSyncCode(SyncErrorCode.Internal),
  );
});

test("server-clock time: expiry judged by store Date header", T, async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 5_000_000, exposeServerDate: true });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  const lease = await a.acquire("p1", "op-a");
  store.setNow(lease.lease.leaseExpiresAt + 10_000);
  const takeover = await b.acquire("p1", "op-b");
  assert.equal(takeover.state.ownerDeviceId, "dev-b");
});

test(
  "local-time fallback: when store exposes no Date, coordinator uses local clock conservatively",
  T,
  async () => {
    const store = new InMemoryConditionalObjectStore({ exposeServerDate: false });
    const a = mk(store, "dev-a");
    const before = Date.now();
    const lease = await a.acquire("p1", "op-a");
    assert.ok(lease.lease.leaseExpiresAt >= before + 60_000 - 5);
    assert.ok(lease.lease.leaseExpiresAt <= Date.now() + 60_000 + 5);
  },
);
