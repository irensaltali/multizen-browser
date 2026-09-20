import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncErrorCode, isSyncError } from "@multizen/sync-core";
import { CoordinationClient, type FetchLike } from "../CoordinationClient.ts";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(
  handler: (r: Recorded) => { status: number; body?: unknown },
): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const rec: Recorded = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(rec);
    const { status, body } = handler(rec);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

const config = {
  workerUrl: "https://sync.example.com/",
  accessClientId: "client-id.access",
  accessClientSecret: "client-secret",
  deviceId: "device_abc",
};

test("acquire sends deviceId + operationId with Access headers to the right route", async () => {
  const { fetchImpl, calls } = stub(() => ({
    status: 200,
    body: {
      state: { profileId: "p1", currentRevision: 3, latestSnapshotId: "s3", ownerDeviceId: "device_abc", leaseExpiresAt: 1, fencingToken: 5 },
      lease: { leaseId: "lease123456789012", fencingToken: 5, leaseExpiresAt: 1000, leaseTtlMs: 45000, recommendedRenewalMs: 15000 },
    },
  }));
  const c = new CoordinationClient(config, fetchImpl);
  const r = await c.acquire("p1", "op_12345678");
  assert.equal(r.lease.leaseId, "lease123456789012");
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://sync.example.com/v1/profiles/p1/acquire");
  assert.deepEqual(call.body, { deviceId: "device_abc", operationId: "op_12345678" });
  assert.equal(call.headers["CF-Access-Client-Id"], "client-id.access");
  assert.equal(call.headers["CF-Access-Client-Secret"], "client-secret");
});

test("renew sends leaseId + fencingToken + operationId", async () => {
  const { fetchImpl, calls } = stub(() => ({
    status: 200,
    body: {
      state: { profileId: "p1", currentRevision: 3, latestSnapshotId: null, ownerDeviceId: "device_abc", leaseExpiresAt: 1, fencingToken: 5 },
      lease: { leaseId: "lease123456789012", fencingToken: 5, leaseExpiresAt: 2000, leaseTtlMs: 45000, recommendedRenewalMs: 15000 },
    },
  }));
  const c = new CoordinationClient(config, fetchImpl);
  await c.renew("p1", "lease123456789012", 5, "op_87654321");
  assert.deepEqual(calls[0]!.body, {
    deviceId: "device_abc",
    leaseId: "lease123456789012",
    fencingToken: 5,
    operationId: "op_87654321",
  });
  assert.equal(calls[0]!.url, "https://sync.example.com/v1/profiles/p1/renew");
});

test("publish sends expectedRevision + latestSnapshotId + fencing fields", async () => {
  const { fetchImpl, calls } = stub(() => ({
    status: 200,
    body: {
      state: { profileId: "p1", currentRevision: 4, latestSnapshotId: "snap4", ownerDeviceId: "device_abc", leaseExpiresAt: 1, fencingToken: 5 },
      revision: 4,
    },
  }));
  const c = new CoordinationClient(config, fetchImpl);
  const r = await c.publish("p1", {
    leaseId: "lease123456789012",
    fencingToken: 5,
    operationId: "op_publish01",
    expectedRevision: 3,
    latestSnapshotId: "snap4",
  });
  assert.equal(r.revision, 4);
  assert.deepEqual(calls[0]!.body, {
    deviceId: "device_abc",
    leaseId: "lease123456789012",
    fencingToken: 5,
    operationId: "op_publish01",
    expectedRevision: 3,
    latestSnapshotId: "snap4",
  });
});

test("getState maps NOT_FOUND to not-found (revision 0 semantics)", async () => {
  const { fetchImpl } = stub(() => ({
    status: 404,
    body: { error: { code: "NOT_FOUND", message: "no state yet" } },
  }));
  const c = new CoordinationClient(config, fetchImpl);
  const r = await c.getState("p1");
  assert.equal(r.kind, "not-found");
});

test("getState returns state on 200", async () => {
  const { fetchImpl } = stub(() => ({
    status: 200,
    body: { state: { profileId: "p1", currentRevision: 7, latestSnapshotId: "s7", ownerDeviceId: null, leaseExpiresAt: null, fencingToken: 2 } },
  }));
  const c = new CoordinationClient(config, fetchImpl);
  const r = await c.getState("p1");
  assert.equal(r.kind, "state");
  if (r.kind === "state") assert.equal(r.state.currentRevision, 7);
});

test("LEASE_HELD → LeaseHeldByOther typed error", async () => {
  const { fetchImpl } = stub(() => ({
    status: 409,
    body: { error: { code: "LEASE_HELD", message: "held" } },
  }));
  const c = new CoordinationClient(config, fetchImpl);
  await assert.rejects(
    () => c.acquire("p1", "op_12345678"),
    (err: unknown) => isSyncError(err) && err.code === SyncErrorCode.LeaseHeldByOther,
  );
});

test("FENCING_TOKEN_INVALID → LeaseFenced; REVISION_CONFLICT → PublishRejected", async () => {
  const fencing = stub(() => ({ status: 409, body: { error: { code: "FENCING_TOKEN_INVALID", message: "stale" } } }));
  const c1 = new CoordinationClient(config, fencing.fetchImpl);
  await assert.rejects(
    () => c1.renew("p1", "lease123456789012", 1, "op_12345678"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseFenced,
  );

  const rev = stub(() => ({ status: 409, body: { error: { code: "REVISION_CONFLICT", message: "cas" } } }));
  const c2 = new CoordinationClient(config, rev.fetchImpl);
  await assert.rejects(
    () =>
      c2.publish("p1", {
        leaseId: "lease123456789012",
        fencingToken: 1,
        operationId: "op_12345678",
        expectedRevision: 0,
        latestSnapshotId: "s",
      }),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.PublishRejected,
  );
});

test("UNAUTHORIZED/FORBIDDEN backend codes → BackendAuthFailed (not Unreachable)", async () => {
  const unauth = stub(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "no token" } } }));
  const c1 = new CoordinationClient(config, unauth.fetchImpl);
  await assert.rejects(
    () => c1.getState("p1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BackendAuthFailed,
  );

  const forbidden = stub(() => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "denied" } } }));
  const c2 = new CoordinationClient(config, forbidden.fetchImpl);
  await assert.rejects(
    () => c2.acquire("p1", "op_12345678"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BackendAuthFailed,
  );
});

test("bare 403 (no backend code) → BackendAuthFailed with credential-hint message", async () => {
  const { fetchImpl } = stub(() => ({ status: 403, body: {} }));
  const c = new CoordinationClient(config, fetchImpl);
  await assert.rejects(
    () => c.getState("p1"),
    (e: unknown) =>
      isSyncError(e) &&
      e.code === SyncErrorCode.BackendAuthFailed &&
      /Access client id\/secret/i.test(e.message),
  );
});

test("network failure → BackendUnreachable", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  const c = new CoordinationClient(config, fetchImpl);
  await assert.rejects(
    () => c.getState("p1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BackendUnreachable,
  );
});

test("missing workerUrl → BackendUnreachable before any fetch", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return { status: 200, ok: true, text: async () => "{}" };
  };
  const c = new CoordinationClient({ ...config, workerUrl: "" }, fetchImpl);
  await assert.rejects(
    () => c.getState("p1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BackendUnreachable,
  );
  assert.equal(called, false);
});

test("health probe returns true only on healthy 2xx", async () => {
  const healthy = stub(() => ({ status: 200, body: { status: "ok" } }));
  assert.equal(await new CoordinationClient(config, healthy.fetchImpl).health(), true);
  const down = stub(() => ({ status: 500, body: {} }));
  assert.equal(await new CoordinationClient(config, down.fetchImpl).health(), false);
});
