import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";

import { verifyTrustRegistry, type TrustEntry } from "../trust.js";
import { InMemoryVault, type SigningKey } from "../vault.js";
import { pendingDeviceKey, trustRegistryKey } from "./keys.js";
import { TrustRegistrySync, TrustSyncError } from "./trustSync.js";

const PREFIX = "repo";

async function key(): Promise<SigningKey> {
  return new InMemoryVault().getOrCreateSigningKey();
}

test("first-device bootstrap creates a self-verifying trust root", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const k = await key();
  const reg = await sync.bootstrap(k);
  verifyTrustRegistry(reg);
  assert.equal(reg.revision, 1);
  assert.equal(reg.entries.length, 1);
  assert.equal(reg.entries[0]!.deviceId, k.deviceId);
  assert.equal(reg.entries[0]!.role, "trusted");
  assert.ok(store.has(trustRegistryKey(PREFIX)));
});

test("fresh device fetches and self-verifies the existing registry", async () => {
  const store = new InMemoryConditionalObjectStore();
  const root = await key();
  await new TrustRegistrySync(store, PREFIX).bootstrap(root);

  // A different device just reads it — no prior local state.
  const fresh = new TrustRegistrySync(store, PREFIX);
  const fetched = await fresh.fetch();
  assert.ok(fetched);
  verifyTrustRegistry(fetched!.registry);
  assert.equal(fetched!.registry.signer, root.deviceId);
});

test("second concurrent bootstrap loses cleanly and returns existing", async () => {
  const store = new InMemoryConditionalObjectStore();
  const kA = await key();
  const kB = await key();
  const first = await new TrustRegistrySync(store, PREFIX).bootstrap(kA);
  const second = await new TrustRegistrySync(store, PREFIX).bootstrap(kB);
  // Whoever created first wins; the loser observes the existing root.
  assert.equal(second.signer, first.signer);
  assert.equal(second.signer, kA.deviceId);
});

test("active trusted admin can add a device via signed CAS update", async () => {
  const store = new InMemoryConditionalObjectStore();
  const admin = await key();
  const newcomer = await key();
  const sync = new TrustRegistrySync(store, PREFIX);
  await sync.bootstrap(admin);
  const entries: TrustEntry[] = [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
    { deviceId: newcomer.deviceId, publicKeyHex: newcomer.publicKeyHex, role: "trusted" },
  ];
  const updated = await sync.update(admin, entries);
  assert.equal(updated.revision, 2);
  verifyTrustRegistry(updated);
  const refetched = await sync.fetch();
  assert.equal(refetched!.registry.entries.length, 2);
});

test("non-admin cannot update the registry", async () => {
  const store = new InMemoryConditionalObjectStore();
  const admin = await key();
  const stranger = await key();
  const sync = new TrustRegistrySync(store, PREFIX);
  await sync.bootstrap(admin);
  await assert.rejects(
    () =>
      sync.update(stranger, [
        { deviceId: stranger.deviceId, publicKeyHex: stranger.publicKeyHex, role: "trusted" },
      ]),
    (e: unknown) => e instanceof TrustSyncError && e.code === "not-admin",
  );
});

test("revoked admin cannot update the registry", async () => {
  const store = new InMemoryConditionalObjectStore();
  const admin = await key();
  const other = await key();
  const sync = new TrustRegistrySync(store, PREFIX);
  await sync.bootstrap(admin);
  // admin adds `other` as trusted, then revokes admin (self-demote via other).
  await sync.update(admin, [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
    { deviceId: other.deviceId, publicKeyHex: other.publicKeyHex, role: "trusted" },
  ]);
  await sync.update(other, [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "revoked" },
    { deviceId: other.deviceId, publicKeyHex: other.publicKeyHex, role: "trusted" },
  ]);
  // Now the revoked admin tries to act.
  await assert.rejects(
    () =>
      sync.update(admin, [
        { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
      ]),
    (e: unknown) => e instanceof TrustSyncError && e.code === "not-admin",
  );
});

test("concurrent registry update loses cleanly (conflict)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const admin = await key();
  const sync = new TrustRegistrySync(store, PREFIX);
  await sync.bootstrap(admin);
  // Two updates racing off the same fetched etag: park the second's CAS.
  const gate = store.gate("put", (k) => k.endsWith("trust/registry.json"));
  const p1 = sync.update(admin, [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
  ]);
  await gate.reached;
  // A separate sync instance updates first, off the same base etag.
  const sync2 = new TrustRegistrySync(store, PREFIX);
  await sync2.update(admin, [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
  ]);
  gate.release();
  await assert.rejects(
    () => p1,
    (e: unknown) => e instanceof TrustSyncError && e.code === "conflict",
  );
});

test("tampered stored registry is rejected as invalid (never returned usable)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const admin = await key();
  const sync = new TrustRegistrySync(store, PREFIX);
  await sync.bootstrap(admin);
  const k = trustRegistryKey(PREFIX);
  const rec = JSON.parse((await store.get(k)).text) as Record<string, unknown>;
  rec.signature = "00".repeat(64);
  const etag = (await store.get(k)).etag;
  await store.putCompareAndSwap(k, new TextEncoder().encode(JSON.stringify(rec)), etag);
  await assert.rejects(
    () => sync.fetch(),
    (e: unknown) => e instanceof TrustSyncError && e.code === "invalid-registry",
  );
});

test("registry stores only public material (secret canary)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const admin = await key();
  await new TrustRegistrySync(store, PREFIX).bootstrap(admin);
  const text = store.rawText(trustRegistryKey(PREFIX)) ?? "";
  assert.ok(!text.includes("PRIVATE"));
  assert.ok(!text.toLowerCase().includes("private key"));
});

test("an unapproved device can announce itself and be discovered", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const admin = await key();
  await sync.bootstrap(admin);

  // A second device, absent from the registry, announces itself.
  const newcomer = await key();
  const announced = await sync.announce(newcomer, "Bea's laptop");
  assert.equal(announced.deviceId, newcomer.deviceId);

  const pending = await sync.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.deviceId, newcomer.deviceId);
  assert.equal(pending[0]?.name, "Bea's laptop");
});

test("announcing twice replaces the record rather than duplicating it", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const k = await key();
  const firstSeen = new Date("2026-01-01T00:00:00.000Z");
  await sync.announce(k, "first", firstSeen);
  await sync.announce(k, "second", new Date("2026-02-01T00:00:00.000Z"));
  const pending = await sync.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.name, "second");
  assert.equal(pending[0]?.announcedAt, firstSeen.toISOString());
});

test("announcements carry no private material (secret canary)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const k = await key();
  await sync.announce(k, "laptop");
  const text = store.rawText(pendingDeviceKey(PREFIX, k.deviceId)) ?? "";
  assert.ok(!text.includes("PRIVATE"));
  assert.ok(!text.toLowerCase().includes("private key"));
});

test("a tampered announcement is dropped, not surfaced", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const k = await key();
  await sync.announce(k, "honest");

  const objectKey = pendingDeviceKey(PREFIX, k.deviceId);
  const got = await store.get(objectKey);
  const body = JSON.parse(got.text) as Record<string, unknown>;
  body.name = "impostor";
  await store.putCompareAndSwap(objectKey, Buffer.from(JSON.stringify(body)), got.etag);

  // The signature covers the name, so mutating it invalidates the record.
  assert.deepEqual(await sync.listPending(), []);
});

test("an announcement whose id disagrees with its key is dropped", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const a = await key();
  const b = await key();
  await sync.announce(a, "a");

  // Move A's signed record to B's filename: the content/key disagreement must be
  // caught, so an announcement cannot be replayed under another device's id.
  const got = await store.get(pendingDeviceKey(PREFIX, a.deviceId));
  await store.putCreate(pendingDeviceKey(PREFIX, b.deviceId), Buffer.from(got.text));

  const pending = await sync.listPending();
  assert.deepEqual(
    pending.map((p) => p.deviceId),
    [a.deviceId],
    "only the record under its own id is accepted",
  );
});

test("a malformed announcement does not hide the valid ones", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const good = await key();
  await sync.announce(good, "good");
  await store.putCreate(
    pendingDeviceKey(PREFIX, "dev_deadbeefdeadbeefdeadbeefdeadbeef"),
    Buffer.from("not json at all"),
  );

  const pending = await sync.listPending();
  assert.deepEqual(pending.map((p) => p.name), ["good"]);
});

test("announcing never grants authority: the registry is unchanged", async () => {
  const store = new InMemoryConditionalObjectStore();
  const sync = new TrustRegistrySync(store, PREFIX);
  const admin = await key();
  const root = await sync.bootstrap(admin);
  const newcomer = await key();
  await sync.announce(newcomer, "newcomer");

  const after = await sync.fetch();
  assert.equal(after?.registry.revision, root.revision);
  assert.deepEqual(
    after?.registry.entries.map((e) => e.deviceId),
    [admin.deviceId],
    "an announcement does not become an entry",
  );
  // And it still cannot promote itself.
  await assert.rejects(
    () =>
      sync.update(newcomer, [
        { deviceId: newcomer.deviceId, publicKeyHex: newcomer.publicKeyHex, role: "trusted" },
      ] as TrustEntry[]),
    (e: unknown) => e instanceof TrustSyncError && e.code === "not-admin",
  );
});
