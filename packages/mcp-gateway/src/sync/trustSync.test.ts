import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";

import { verifyTrustRegistry, type TrustEntry } from "../trust.js";
import { InMemoryVault, type SigningKey } from "../vault.js";
import { trustRegistryKey } from "./keys.js";
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
