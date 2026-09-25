import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import { selectRevisionAt, type SyncObjectStore, type TrustEntry } from "@multizen/mcp-gateway";

import { GatewayController } from "../GatewayController.ts";
import { GatewayService } from "../GatewayService.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

/**
 * Configuration history as the operator meets it: a timeline per project and a
 * rollback that behaves like an edit rather than a rewind.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

interface Device {
  svc: GatewayService;
  ctl: GatewayController;
  vault: MemoryVault;
  cleanup: () => void;
}

async function device(
  store: InMemoryConditionalObjectStore | null,
  vault = new MemoryVault(),
): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), "gw-hist-"));
  const svc = new GatewayService({
    dataDir: dir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
    ...(store
      ? {
          syncMaterials: async () => ({
            store: store as unknown as SyncObjectStore,
            controlPrefix: PREFIX,
            password: PASSWORD,
            deviceId: "d",
          }),
        }
      : {}),
  });
  await svc.start();
  return {
    svc,
    ctl: new GatewayController(svc, { baseUrl: svc.baseUrl, routesServed: () => true }),
    vault,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function trust(admin: Device, ...others: Device[]): Promise<void> {
  const bridge = admin.svc.syncBridge;
  assert.ok(bridge);
  await bridge.ensureTrustRegistry();
  const entries = new Map<string, TrustEntry>();
  for (const d of [admin, ...others]) {
    const k = await d.svc.vaultAdapter.getOrCreateSigningKey();
    entries.set(k.deviceId, {
      deviceId: k.deviceId,
      publicKeyHex: k.publicKeyHex,
      role: "trusted",
    } as TrustEntry);
  }
  await bridge.approveDevice([...entries.values()]);
}

/** Make `count` successive edits to a project, each with a distinct label. */
async function edit(d: Device, id: string, labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    const res = await d.ctl.updateProject(id, { label });
    assert.ok(res.ok, `updateProject ${label}: ${JSON.stringify(res)}`);
  }
}

// ── the timeline ────────────────────────────────────────────────────────────

test("a project's edits appear as a timeline, newest first, with the current one marked", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "v1", enabled: true })).ok);
    await edit(a, "alpha", ["v2", "v3"]);

    const res = await a.ctl.projectHistory("alpha");
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.deepEqual(res.value.map((e) => e.revision), [3, 2, 1]);
    assert.deepEqual(
      res.value.map((e) => e.current),
      [true, false, false],
    );
    assert.ok(res.value.every((e) => !e.deleted));
    // Timestamps come from signed stamps, so they are present and parseable.
    assert.ok(res.value.every((e) => e.archivedAt !== null && !Number.isNaN(Date.parse(e.archivedAt))));
  } finally {
    a.cleanup();
  }
});

test("a device-only project reports an empty history, not an error", async () => {
  // History lives in the bucket. Without Cloud Sync there genuinely is none, and
  // saying so is different from failing.
  const a = await device(null);
  try {
    assert.ok((await a.ctl.createProject({ id: "alpha", enabled: true })).ok);
    const res = await a.ctl.projectHistory("alpha");
    assert.ok(res.ok);
    if (res.ok) assert.deepEqual(res.value, []);
  } finally {
    a.cleanup();
  }
});

test("history for a project that never existed is a not-found, not an empty list", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    const res = await a.ctl.projectHistory("nosuchproject");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "not-found");
  } finally {
    a.cleanup();
  }
});

test("a deletion shows in the timeline of a project this device still remembers", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "v1", enabled: true })).ok);
    await b.svc.syncNow();
    // A deletes it; B learns about the deletion but keeps its revision bookkeeping.
    assert.ok((await a.ctl.deleteProject("alpha")).ok);

    const res = await b.ctl.projectHistory("alpha");
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.ok(
      res.value.some((e) => e.deleted),
      `the deletion should be in the timeline: ${JSON.stringify(res.value)}`,
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── rolling back ────────────────────────────────────────────────────────────

test("restoring an old revision republishes it forward instead of rewinding", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "original", enabled: true })).ok);
    await edit(a, "alpha", ["a mistake"]);
    assert.equal(a.svc.configOf("alpha")?.label, "a mistake");

    const res = await a.ctl.restoreProjectRevision("alpha", 1);
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.value.fromRevision, 1);
    // A NEW revision, not a reset to 1: other devices must see an ordinary edit,
    // not something their replay protection would refuse.
    assert.equal(res.value.revision, 3);
    assert.equal(a.svc.configOf("alpha")?.label, "original");

    // And the mistake is still in history, so the rollback itself is undoable.
    const hist = await a.ctl.projectHistory("alpha");
    assert.ok(hist.ok);
    if (!hist.ok) return;
    assert.deepEqual(hist.value.map((e) => e.revision), [3, 2, 1]);
    assert.equal(hist.value[0]?.current, true);
  } finally {
    a.cleanup();
  }
});

test("a rolled-back config reaches the other device as a normal edit", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "original", enabled: true })).ok);
    await edit(a, "alpha", ["a mistake"]);
    await b.svc.syncNow();
    assert.equal(b.svc.configOf("alpha")?.label, "a mistake");

    assert.ok((await a.ctl.restoreProjectRevision("alpha", 1)).ok);
    await b.svc.syncNow();
    // Accepted, not quarantined as a rollback.
    assert.equal(b.svc.configOf("alpha")?.label, "original");
    assert.equal(b.svc.syncStatusView().quarantined, 0);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("restoring the revision already applied is refused as a no-op", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "only", enabled: true })).ok);
    const res = await a.ctl.restoreProjectRevision("alpha", 1);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "unchanged");
      assert.match(res.error.message, /identical to the current configuration/i);
    }
  } finally {
    a.cleanup();
  }
});

test("a pruned revision is refused with the reason named", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "v1", enabled: true })).ok);
    const res = await a.ctl.restoreProjectRevision("alpha", 99);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "absent");
      // Actionable: says WHY it might be gone rather than just "not found".
      assert.match(res.error.message, /retention limit/i);
    }
  } finally {
    a.cleanup();
  }
});

test("rolling back needs Cloud Sync and says so", async () => {
  const a = await device(null);
  try {
    assert.ok((await a.ctl.createProject({ id: "alpha", enabled: true })).ok);
    const res = await a.ctl.restoreProjectRevision("alpha", 1);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "not-syncing");
      assert.match(res.error.message, /only on this device/i);
    }
  } finally {
    a.cleanup();
  }
});

test("a nonsense revision is rejected before any work happens", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    for (const bad of [0, -1, 1.5]) {
      const res = await a.ctl.restoreProjectRevision("alpha", bad);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error.code, "invalid");
    }
  } finally {
    a.cleanup();
  }
});

// ── point in time ───────────────────────────────────────────────────────────

test("the timeline plus a timestamp recovers the configuration of that moment", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "monday", enabled: true })).ok);
    await new Promise((r) => setTimeout(r, 5));
    await edit(a, "alpha", ["tuesday"]);
    await new Promise((r) => setTimeout(r, 5));
    await edit(a, "alpha", ["wednesday"]);

    const hist = await a.svc.projectHistory("alpha");
    assert.equal(hist.length, 3);
    const second = hist.find((e) => e.revision === 2);
    assert.ok(second?.archivedAt);

    // "As it was just after the second edit" must select revision 2, not 3.
    const chosen = selectRevisionAt(hist, Date.parse(second.archivedAt) + 1);
    assert.equal(chosen?.revision, 2);

    const res = await a.ctl.restoreProjectRevision("alpha", chosen?.revision ?? 0);
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(a.svc.configOf("alpha")?.label, "tuesday");
  } finally {
    a.cleanup();
  }
});

test("retention bounds what a project accumulates without touching current state", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "v1", enabled: true })).ok);
    // Well past the default retention limit of 20.
    await edit(
      a,
      "alpha",
      Array.from({ length: 24 }, (_, i) => `v${i + 2}`),
    );

    const res = await a.ctl.projectHistory("alpha");
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.length, 20, "the archive is capped at the retention limit");
    // The newest is retained and is the live config; the oldest are gone.
    assert.equal(res.value[0]?.revision, 25);
    assert.equal(res.value[0]?.current, true);
    assert.equal(a.svc.configOf("alpha")?.label, "v25");
    assert.ok(!res.value.some((e) => e.revision === 1));
  } finally {
    a.cleanup();
  }
});

test("history never exposes a secret value", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    assert.ok((await a.ctl.createProject({ id: "alpha", label: "v1", enabled: true })).ok);
    assert.ok(
      (
        await a.ctl.addServer("alpha", {
          transport: "stdio",
          id: "srv",
          command: "echo",
          args: [],
          secretValues: { TOKEN: "sk-canary-in-history" },
        })
      ).ok,
    );
    const res = await a.ctl.projectHistory("alpha");
    assert.ok(res.ok);
    assert.ok(!JSON.stringify(res).includes("sk-canary-in-history"));
  } finally {
    a.cleanup();
  }
});
