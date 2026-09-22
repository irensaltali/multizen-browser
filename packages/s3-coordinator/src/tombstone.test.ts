import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncErrorCode } from "@multizen/sync-core";
import { InMemoryConditionalObjectStore } from "./inMemoryStore.js";
import { S3Coordinator, type S3CoordinatorConfig } from "./coordinator.js";
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

/** Acquire → publish a snapshot so the profile is committed (revision >= 1). */
async function commitProfile(
  c: S3Coordinator,
  profileId: string,
  snap: string,
): Promise<{ leaseId: string; fencingToken: number }> {
  const lease = await c.acquire(profileId, `acq-${profileId}`);
  await c.publish(profileId, {
    leaseId: lease.lease.leaseId,
    fencingToken: lease.lease.fencingToken,
    operationId: `pub-${profileId}-${snap}`,
    expectedRevision: 0,
    latestSnapshotId: snap,
  });
  return { leaseId: lease.lease.leaseId, fencingToken: lease.lease.fencingToken };
}

// ── listProfiles ─────────────────────────────────────────────────────────────

test("listProfiles: returns only committed, non-tombstoned profiles", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = mk(store, "dev-a");
  await commitProfile(c, "p1", "s1");
  await commitProfile(c, "p2", "s2");
  // p3 acquired but never published → revision 0 → excluded.
  await c.acquire("p3", "acq-p3");
  const res = await c.listProfiles();
  const ids = res.profiles.map((p) => p.profileId).sort();
  assert.deepEqual(ids, ["p1", "p2"]);
  assert.equal(res.skipped.length, 0);
  assert.ok(res.scanned >= 3);
  assert.equal(res.truncated, false);
});

test("listProfiles: ignores capability/history/probe/nested/unsafe keys", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = mk(store, "dev-a");
  await commitProfile(c, "p1", "s1");
  const enc = new TextEncoder();
  // Inject noise keys under the control prefix.
  await store.putCreate("control/capabilities/tok.json", enc.encode("{}"));
  await store.putCreate("control/profiles/p1/history/2.json", enc.encode("{}"));
  await store.putCreate("control/profiles/p1/probes/x.json", enc.encode("{}"));
  await store.putCreate("control/profiles/deep/nested/state.json", enc.encode("{}"));
  const res = await c.listProfiles();
  assert.deepEqual(res.profiles.map((p) => p.profileId), ["p1"]);
});

test("listProfiles: reports malformed state.json in skipped, never in profiles", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = mk(store, "dev-a");
  await commitProfile(c, "good", "s1");
  const enc = new TextEncoder();
  // A safe-id state key with a corrupt body.
  await store.putCreate(stateKey(PREFIX, "bad"), enc.encode("not json"));
  const res = await c.listProfiles();
  assert.deepEqual(res.profiles.map((p) => p.profileId), ["good"]);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0]!.profileId, "bad");
});

test("listProfiles: paginates across many profiles (small page size)", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = mk(store, "dev-a", { listPageSize: 2 });
  for (let i = 0; i < 5; i++) await commitProfile(c, `p${i}`, `s${i}`);
  const res = await c.listProfiles();
  assert.equal(res.profiles.length, 5);
  const ids = res.profiles.map((p) => p.profileId).sort();
  assert.deepEqual(ids, ["p0", "p1", "p2", "p3", "p4"]);
});

test("listProfiles: total-scan cap sets truncated and stops early", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const c = mk(store, "dev-a", { maxScanKeys: 2, listPageSize: 10 });
  for (let i = 0; i < 5; i++) await commitProfile(c, `p${i}`, `s${i}`);
  const res = await c.listProfiles();
  assert.equal(res.truncated, true);
  assert.ok(res.scanned <= 2);
});

// ── tombstone blocking ───────────────────────────────────────────────────────

test("tombstone: requires exact owner lease/fencing; blocks acquire/renew/publish", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const { leaseId, fencingToken } = await commitProfile(a, "p1", "s1");

  // wrong lease id → not owner
  await assert.rejects(
    () => a.tombstoneProfile("p1", { leaseId: "wrong", fencingToken, operationId: "op-del-x" }),
    isSyncCode(SyncErrorCode.LeaseHeldByOther),
  );
  // wrong fencing → fenced
  await assert.rejects(
    () => a.tombstoneProfile("p1", { leaseId, fencingToken: fencingToken + 9, operationId: "op-del-y" }),
    isSyncCode(SyncErrorCode.LeaseFenced),
  );

  // correct owner → tombstones
  const del = await a.tombstoneProfile("p1", { leaseId, fencingToken, operationId: "op-del", reason: "bye" });
  assert.equal(del.tombstoned, true);
  assert.equal(del.state.deleted, true);
  assert.equal(del.state.generation, 1);
  assert.equal(del.state.ownerDeviceId, null);

  // now all lease/publish ops fail closed with ProfileDeleted
  await assert.rejects(() => a.acquire("p1", "acq2"), isSyncCode(SyncErrorCode.ProfileDeleted));
  await assert.rejects(
    () => a.renew("p1", leaseId, fencingToken, "ren2"),
    isSyncCode(SyncErrorCode.ProfileDeleted),
  );
  await assert.rejects(
    () =>
      a.publish("p1", {
        leaseId,
        fencingToken,
        operationId: "pub2",
        expectedRevision: 1,
        latestSnapshotId: "s2",
      }),
    isSyncCode(SyncErrorCode.ProfileDeleted),
  );
});

test("tombstone: excluded from listProfiles", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  await commitProfile(a, "keep", "s1");
  const { leaseId, fencingToken } = await commitProfile(a, "gone", "s2");
  await a.tombstoneProfile("gone", { leaseId, fencingToken, operationId: "op-del" });
  const res = await a.listProfiles();
  assert.deepEqual(res.profiles.map((p) => p.profileId), ["keep"]);
});

test("tombstone: idempotent by operationId (no double bump)", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const { leaseId, fencingToken } = await commitProfile(a, "p1", "s1");
  const first = await a.tombstoneProfile("p1", { leaseId, fencingToken, operationId: "op-del" });
  const replay = await a.tombstoneProfile("p1", { leaseId, fencingToken, operationId: "op-del" });
  assert.equal(first.state.generation, 1);
  assert.equal(replay.state.generation, 1, "replay does not bump generation again");
  assert.equal(replay.tombstoned, true);
});

test("tombstone: second delete with a different op is an idempotent success (already deleted)", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const { leaseId, fencingToken } = await commitProfile(a, "p1", "s1");
  await a.tombstoneProfile("p1", { leaseId, fencingToken, operationId: "op-del-1" });
  const again = await a.tombstoneProfile("p1", {
    leaseId,
    fencingToken,
    operationId: "op-del-2",
  });
  assert.equal(again.tombstoned, true);
  assert.equal(again.state.generation, 1, "already-tombstoned does not re-bump");
});

// ── revive ───────────────────────────────────────────────────────────────────

test("revive: increments generation, resets revision line, fences stale peer", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const { leaseId, fencingToken } = await commitProfile(a, "p1", "s1");
  await a.tombstoneProfile("p1", { leaseId, fencingToken, operationId: "op-del" });

  const rev = await a.reviveProfile("p1", "op-rev");
  assert.equal(rev.revived, true);
  assert.equal(rev.state.deleted, false);
  assert.equal(rev.state.generation, 2, "generation bumped on delete(1) then revive(2)");
  assert.equal(rev.state.currentRevision, 0, "fresh revision line");
  assert.equal(rev.state.fencingToken, 0, "fencing reset for new generation");
  assert.equal(rev.state.latestSnapshotId, null);

  // A stale peer holding the pre-deletion fencing token cannot renew/publish:
  // the profile now needs a fresh acquire. Old token belongs to generation 1.
  await assert.rejects(
    () => a.renew("p1", leaseId, fencingToken, "ren-stale"),
    isSyncCode(SyncErrorCode.LeaseHeldByOther),
  );

  // A fresh acquire works and starts fencing at 1 in the new generation.
  const fresh = await a.acquire("p1", "acq-fresh");
  assert.equal(fresh.lease.fencingToken, 1);
  assert.equal(fresh.state.generation, 2);
});

test("revive: idempotent by operationId", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const { leaseId, fencingToken } = await commitProfile(a, "p1", "s1");
  await a.tombstoneProfile("p1", { leaseId, fencingToken, operationId: "op-del" });
  const first = await a.reviveProfile("p1", "op-rev");
  const replay = await a.reviveProfile("p1", "op-rev");
  assert.equal(first.state.generation, 2);
  assert.equal(replay.state.generation, 2, "replay does not bump again");
});

test("revive: reviving a live (non-tombstoned) profile is a no-op success", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  await commitProfile(a, "p1", "s1");
  const res = await a.reviveProfile("p1", "op-rev");
  assert.equal(res.revived, true);
  assert.equal(res.state.generation, 0, "no generation bump for a live profile");
  assert.equal(res.state.currentRevision, 1, "live revision preserved");
});

test("revive then re-tombstone: generation keeps climbing", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const first = await commitProfile(a, "p1", "s1");
  await a.tombstoneProfile("p1", { leaseId: first.leaseId, fencingToken: first.fencingToken, operationId: "d1" });
  await a.reviveProfile("p1", "r1"); // generation 2
  const relive = await a.acquire("p1", "acq2");
  await a.publish("p1", {
    leaseId: relive.lease.leaseId,
    fencingToken: relive.lease.fencingToken,
    operationId: "pub2",
    expectedRevision: 0,
    latestSnapshotId: "s2",
  });
  const del2 = await a.tombstoneProfile("p1", {
    leaseId: relive.lease.leaseId,
    fencingToken: relive.lease.fencingToken,
    operationId: "d2",
  });
  assert.equal(del2.state.generation, 3, "delete(1)→revive(2)→delete(3)");
});

// ── stale peer CAS/fencing during tombstone ──────────────────────────────────

test("tombstone: concurrent takeover fences the stale deleter (CAS re-read)", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  const b = mk(store, "dev-b");
  const first = await commitProfile(a, "p1", "s1");
  // dev-a's lease expires; dev-b takes over past the skew margin.
  const st = await a.getState("p1");
  assert.equal(st.kind, "state");
  store.setNow(1_000_000 + TTL + SKEW + 1);
  await b.acquire("p1", "acq-b"); // takeover bumps fencing
  // dev-a now tries to delete with its stale lease/token → must be fenced/denied.
  await assert.rejects(
    () =>
      a.tombstoneProfile("p1", {
        leaseId: first.leaseId,
        fencingToken: first.fencingToken,
        operationId: "op-del-stale",
      }),
    (e: unknown) =>
      isSyncCode(SyncErrorCode.LeaseHeldByOther)(e) || isSyncCode(SyncErrorCode.LeaseFenced)(e),
  );
  // profile remains live
  const res = await a.listProfiles();
  assert.deepEqual(res.profiles.map((p) => p.profileId), ["p1"]);
});

// ── optional history cleanup after tombstone ─────────────────────────────────

test("tombstone with cleanupHistory: removes only this profile's revision records, keeps tombstone", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1_000_000 });
  const a = mk(store, "dev-a");
  // Two profiles each publish → each writes a revisions/* record.
  const p1 = await commitProfile(a, "p1", "s1");
  await commitProfile(a, "p2", "s2");
  const revBefore = store.keys().filter((k) => k.startsWith("control/revisions/"));
  assert.equal(revBefore.length, 2);

  const del = await a.tombstoneProfile("p1", {
    leaseId: p1.leaseId,
    fencingToken: p1.fencingToken,
    operationId: "op-del",
    cleanupHistory: true,
  });
  assert.equal(del.tombstoned, true);

  // Only p2's revision record remains; the tombstone (state.json) is untouched.
  const revAfter = store.keys().filter((k) => k.startsWith("control/revisions/"));
  assert.equal(revAfter.length, 1);
  assert.ok(store.has(stateKey(PREFIX, "p1")), "tombstone state.json is never deleted");
});
