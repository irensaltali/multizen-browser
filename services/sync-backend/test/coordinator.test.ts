/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Drive the worker through the pool's bound SELF fetcher (runs in workerd with
// the wrangler.jsonc bindings + test bindings from vitest.config.ts).
async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`https://backend.test${path}`, { method, headers, body: bodyInit });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const opId = (() => {
  let n = 0;
  return () => `op-${Date.now()}-${n++}-abcdef`;
})();

function uniqueProfile(): string {
  return `profile-${crypto.randomUUID()}`;
}

describe("GET /health", () => {
  it("returns ok without auth", async () => {
    const res = await call("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
  });

  it("rejects non-GET", async () => {
    const res = await call("POST", "/health");
    expect(res.status).toBe(405);
    expect(res.json.error.code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("GET /v1/profiles/:id", () => {
  it("404 for a profile with no state", async () => {
    const res = await call("GET", `/v1/profiles/${uniqueProfile()}`);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");
  });

  it("rejects invalid profile id", async () => {
    const res = await call("GET", "/v1/profiles/" + encodeURIComponent("bad id!!"));
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("acquire", () => {
  it("acquires a lease with default 45s ttl and 15s recommended renewal", async () => {
    const profileId = uniqueProfile();
    const res = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    expect(res.status).toBe(200);
    expect(res.json.lease.leaseTtlMs).toBe(45000);
    expect(res.json.lease.recommendedRenewalMs).toBe(15000);
    expect(typeof res.json.lease.leaseId).toBe("string");
    expect(res.json.lease.fencingToken).toBe(1);
    expect(res.json.state.ownerDeviceId).toBe("device_a");
    expect(res.json.state.currentRevision).toBe(0);
  });

  it("blocks a second device while lease is held", async () => {
    const profileId = uniqueProfile();
    await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_b", operationId: opId() },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("LEASE_HELD");
  });

  it("is idempotent on operationId", async () => {
    const profileId = uniqueProfile();
    const operationId = opId();
    const first = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId },
    });
    const second = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId },
    });
    expect(second.status).toBe(200);
    expect(second.json.lease.leaseId).toBe(first.json.lease.leaseId);
    expect(second.json.lease.fencingToken).toBe(first.json.lease.fencingToken);
  });

  it("validates missing deviceId", async () => {
    const res = await call("POST", `/v1/profiles/${uniqueProfile()}/acquire`, {
      body: { operationId: opId() },
    });
    expect(res.status).toBe(422);
  });
});

describe("renew", () => {
  it("renews and keeps the same fencing token", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/renew`, {
      body: {
        deviceId: "device_a",
        leaseId: acq.json.lease.leaseId,
        fencingToken: acq.json.lease.fencingToken,
        operationId: opId(),
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.lease.fencingToken).toBe(acq.json.lease.fencingToken);
  });

  it("rejects wrong leaseId", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/renew`, {
      body: {
        deviceId: "device_a",
        leaseId: "x".repeat(43),
        fencingToken: acq.json.lease.fencingToken,
        operationId: opId(),
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("LEASE_MISMATCH");
  });

  it("requires a fencingToken", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/renew`, {
      body: { deviceId: "device_a", leaseId: acq.json.lease.leaseId, operationId: opId() },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
    expect(res.json.error.details.field).toBe("fencingToken");
  });
});

describe("publish", () => {
  it("publishes with expected-revision CAS and bumps revision", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/publish`, {
      body: {
        deviceId: "device_a",
        leaseId: acq.json.lease.leaseId,
        fencingToken: acq.json.lease.fencingToken,
        operationId: opId(),
        expectedRevision: 0,
        latestSnapshotId: "snap-abc123",
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.revision).toBe(1);
    expect(res.json.state.currentRevision).toBe(1);
    expect(res.json.state.latestSnapshotId).toBe("snap-abc123");
  });

  it("rejects on revision conflict", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/publish`, {
      body: {
        deviceId: "device_a",
        leaseId: acq.json.lease.leaseId,
        fencingToken: acq.json.lease.fencingToken,
        operationId: opId(),
        expectedRevision: 99,
        latestSnapshotId: "snap-xyz",
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("REVISION_CONFLICT");
  });

  it("requires a fencingToken", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/publish`, {
      body: {
        deviceId: "device_a",
        leaseId: acq.json.lease.leaseId,
        operationId: opId(),
        expectedRevision: 0,
        latestSnapshotId: "snap-nofence",
      },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
    expect(res.json.error.details.field).toBe("fencingToken");
  });

  it("publish is idempotent (no double revision bump, stable revision metadata)", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const operationId = opId();
    const body = {
      deviceId: "device_a",
      leaseId: acq.json.lease.leaseId,
      fencingToken: acq.json.lease.fencingToken,
      operationId,
      expectedRevision: 0,
      latestSnapshotId: "snap-idem",
    };
    const first = await call("POST", `/v1/profiles/${profileId}/publish`, { body });
    const second = await call("POST", `/v1/profiles/${profileId}/publish`, { body });
    expect(first.json.revision).toBe(1);
    expect(second.json.revision).toBe(1);

    // Immutable revision metadata retains operation_id + fencing token and is
    // returned identically on the idempotent replay.
    expect(first.json.revisionMeta.operationId).toBe(operationId);
    expect(first.json.revisionMeta.fencingToken).toBe(acq.json.lease.fencingToken);
    expect(first.json.revisionMeta.snapshotId).toBe("snap-idem");
    expect(second.json.revisionMeta).toEqual(first.json.revisionMeta);
  });
});

describe("release + re-acquire", () => {
  it("releases and lets another device acquire with a higher fencing token", async () => {
    const profileId = uniqueProfile();
    const acqA = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const rel = await call("POST", `/v1/profiles/${profileId}/release`, {
      body: {
        deviceId: "device_a",
        leaseId: acqA.json.lease.leaseId,
        fencingToken: acqA.json.lease.fencingToken,
        operationId: opId(),
      },
    });
    expect(rel.status).toBe(200);
    expect(rel.json.released).toBe(true);
    expect(rel.json.state.ownerDeviceId).toBeNull();

    const acqB = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_b", operationId: opId() },
    });
    expect(acqB.status).toBe(200);
    expect(acqB.json.lease.fencingToken).toBeGreaterThan(acqA.json.lease.fencingToken);
  });
});

describe("lease expiry", () => {
  it("lets another device acquire after the lease TTL elapses", async () => {
    const profileId = uniqueProfile();
    const acqA = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId(), leaseTtlMs: 1000 },
    });
    expect(acqA.status).toBe(200);
    expect(acqA.json.lease.leaseTtlMs).toBe(1000);
    await new Promise((r) => setTimeout(r, 1100));
    const acqB = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_b", operationId: opId() },
    });
    expect(acqB.status).toBe(200);
    expect(acqB.json.state.ownerDeviceId).toBe("device_b");
    expect(acqB.json.lease.fencingToken).toBeGreaterThan(acqA.json.lease.fencingToken);
  });

  it("rejects renew after expiry with LEASE_EXPIRED", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId(), leaseTtlMs: 1000 },
    });
    await new Promise((r) => setTimeout(r, 1100));
    const res = await call("POST", `/v1/profiles/${profileId}/renew`, {
      body: {
        deviceId: "device_a",
        leaseId: acq.json.lease.leaseId,
        fencingToken: acq.json.lease.fencingToken,
        operationId: opId(),
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("LEASE_EXPIRED");
  });
});

describe("stale fencing token", () => {
  // Simulate an ownership epoch change: device_a acquires (token=1), the lease
  // expires, device_b acquires (token=2). A stale token from an earlier epoch
  // must be rejected with FENCING_TOKEN_INVALID (409) even if the caller
  // presents a syntactically valid lease id.
  async function setupHigherEpoch(profileId: string) {
    const acqA = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId(), leaseTtlMs: 1000 },
    });
    await new Promise((r) => setTimeout(r, 1100));
    const acqB = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_b", operationId: opId() },
    });
    return { acqA, acqB };
  }

  it("renew rejects a stale fencingToken with FENCING_TOKEN_INVALID", async () => {
    const profileId = uniqueProfile();
    const { acqB } = await setupHigherEpoch(profileId);
    // device_b holds the lease with token=2; presenting token=1 is stale.
    const res = await call("POST", `/v1/profiles/${profileId}/renew`, {
      body: {
        deviceId: "device_b",
        leaseId: acqB.json.lease.leaseId,
        fencingToken: acqB.json.lease.fencingToken - 1,
        operationId: opId(),
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("FENCING_TOKEN_INVALID");
  });

  it("publish rejects a stale fencingToken with FENCING_TOKEN_INVALID", async () => {
    const profileId = uniqueProfile();
    const { acqB } = await setupHigherEpoch(profileId);
    const res = await call("POST", `/v1/profiles/${profileId}/publish`, {
      body: {
        deviceId: "device_b",
        leaseId: acqB.json.lease.leaseId,
        fencingToken: acqB.json.lease.fencingToken - 1,
        operationId: opId(),
        expectedRevision: 0,
        latestSnapshotId: "snap-stale",
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("FENCING_TOKEN_INVALID");
  });

  it("release rejects a stale fencingToken with FENCING_TOKEN_INVALID", async () => {
    const profileId = uniqueProfile();
    const { acqB } = await setupHigherEpoch(profileId);
    const res = await call("POST", `/v1/profiles/${profileId}/release`, {
      body: {
        deviceId: "device_b",
        leaseId: acqB.json.lease.leaseId,
        fencingToken: acqB.json.lease.fencingToken - 1,
        operationId: opId(),
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("FENCING_TOKEN_INVALID");
  });

  it("rejects a mismatched (too-high) fencingToken with FENCING_TOKEN_INVALID", async () => {
    const profileId = uniqueProfile();
    const acq = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
    });
    const res = await call("POST", `/v1/profiles/${profileId}/renew`, {
      body: {
        deviceId: "device_a",
        leaseId: acq.json.lease.leaseId,
        fencingToken: acq.json.lease.fencingToken + 5,
        operationId: opId(),
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("FENCING_TOKEN_INVALID");
  });
});

describe("auth", () => {
  it("binds identity common_name from test headers into owner", async () => {
    const profileId = uniqueProfile();
    const res = await call("POST", `/v1/profiles/${profileId}/acquire`, {
      body: { deviceId: "device_a", operationId: opId() },
      headers: { "x-test-common-name": "svc-token-123", "x-test-subject": "sub-xyz" },
    });
    expect(res.status).toBe(200);
    expect(res.json.state.ownerCommonName).toBe("svc-token-123");
    expect(res.json.state.ownerSubject).toBe("sub-xyz");
  });
});
