import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";

import { InMemoryVault, type SigningKey } from "../vault.js";
import { signTrustRegistry, type TrustEntry, type TrustRegistry } from "../trust.js";
import { generateSaltHex } from "./crypto.js";
import { documentKey } from "./keys.js";
import { SyncedDocumentStore, DocumentStoreError } from "./documentStore.js";
import type { SyncObjectStore } from "./objectStore.js";

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

async function key(): Promise<SigningKey> {
  return new InMemoryVault().getOrCreateSigningKey();
}

/** A registry trusting exactly the given devices. */
async function registryFor(admin: SigningKey, ...others: SigningKey[]): Promise<TrustRegistry> {
  const entries: TrustEntry[] = [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
    ...others.map((k) => ({
      deviceId: k.deviceId,
      publicKeyHex: k.publicKeyHex,
      role: "trusted" as const,
    })),
  ];
  return signTrustRegistry(admin, 1, entries);
}

function makeStore(
  store: SyncObjectStore,
  signingKey: SigningKey,
  password = PASSWORD,
  saltHex = generateSaltHex(),
): SyncedDocumentStore {
  return new SyncedDocumentStore({
    store,
    controlPrefix: PREFIX,
    password,
    saltHex,
    signingKey,
  });
}

function backing(): { inner: InMemoryConditionalObjectStore; store: SyncObjectStore } {
  const inner = new InMemoryConditionalObjectStore();
  return { inner, store: inner as unknown as SyncObjectStore };
}

test("a shared document round-trips through publish and read", async () => {
  const { store } = backing();
  const k = await key();
  const docs = makeStore(store, k);
  const registry = await registryFor(k);

  const published = await docs.publish("shared", "settings", { theme: "dark", port: 7777 }, 1);
  assert.equal(published.kind, "published");

  const read = await docs.read<{ theme: string; port: number }>("shared", "settings", registry);
  assert.equal(read.kind, "loaded");
  if (read.kind !== "loaded") return;
  assert.deepEqual(read.document.value, { theme: "dark", port: 7777 });
  assert.equal(read.document.revision, 1);
  assert.equal(read.document.signer, k.deviceId);
  assert.equal(read.document.scope, "shared");
});

test("an absent document is absent, not an error", async () => {
  const { store } = backing();
  const k = await key();
  const read = await makeStore(store, k).read("shared", "nothinghere", await registryFor(k));
  assert.equal(read.kind, "absent");
});

test("revisions are monotonic and contiguous", async () => {
  const { store } = backing();
  const k = await key();
  const docs = makeStore(store, k);

  assert.equal((await docs.publish("shared", "settings", { v: 1 }, 1)).kind, "published");
  assert.equal((await docs.publish("shared", "settings", { v: 2 }, 2)).kind, "published");

  // Re-publishing an old revision is a conflict, never an overwrite.
  const stale = await docs.publish("shared", "settings", { v: 99 }, 2);
  assert.equal(stale.kind, "conflict");
  if (stale.kind === "conflict") assert.equal(stale.remoteRevision, 2);

  // Skipping ahead is a programming error, not a silent gap.
  await assert.rejects(
    () => docs.publish("shared", "settings", { v: 4 }, 4),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "config",
  );

  // A first publish must be revision 1.
  await assert.rejects(
    () => docs.publish("shared", "fresh", { v: 1 }, 3),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "config",
  );
});

test("two devices racing the same document: the loser is told, not overwritten", async () => {
  const { store } = backing();
  const a = await key();
  const b = await key();
  const salt = generateSaltHex();
  const docsA = makeStore(store, a, PASSWORD, salt);
  const docsB = makeStore(store, b, PASSWORD, salt);

  await docsA.publish("shared", "settings", { from: "a" }, 1);
  // Both try to advance to revision 2; exactly one can win.
  const [ra, rb] = await Promise.all([
    docsA.publish("shared", "settings", { from: "a2" }, 2),
    docsB.publish("shared", "settings", { from: "b2" }, 2),
  ]);
  const kinds = [ra.kind, rb.kind].sort();
  assert.deepEqual(kinds, ["conflict", "published"]);

  // The winner's content is what a reader sees; nothing was merged.
  const read = await docsA.read<{ from: string }>("shared", "settings", await registryFor(a, b));
  assert.equal(read.kind, "loaded");
  if (read.kind !== "loaded") return;
  assert.ok(["a2", "b2"].includes(read.document.value.from));
});

test("the payload is encrypted at rest and never appears in cleartext", async () => {
  const { inner, store } = backing();
  const k = await key();
  const docs = makeStore(store, k);
  await docs.publish("shared", "settings", { apiToken: "sk-super-secret-value" }, 1);

  const raw = inner.rawText(documentKey(PREFIX, "shared", "settings")) ?? "";
  assert.ok(raw.length > 0, "the object exists");
  assert.ok(!raw.includes("sk-super-secret-value"), "no plaintext value on the wire");
  assert.ok(!raw.includes("apiToken"), "not even the key names leak");
  assert.ok(!raw.includes(PASSWORD), "and certainly not the password");
});

test("a document signed by an untrusted device is rejected", async () => {
  const { store } = backing();
  const admin = await key();
  const stranger = await key();
  const salt = generateSaltHex();
  await makeStore(store, stranger, PASSWORD, salt).publish("shared", "settings", { x: 1 }, 1);

  // The registry does not include the stranger.
  const read = await makeStore(store, admin, PASSWORD, salt).read(
    "shared",
    "settings",
    await registryFor(admin),
  );
  assert.equal(read.kind, "rejected");
  if (read.kind !== "rejected") return;
  assert.equal(read.rejection.code, "unknown-signer");
  assert.equal(read.rejection.signer, stranger.deviceId);
  assert.ok(read.rejection.reason.includes(stranger.deviceId));
});

test("a document signed by a revoked device is rejected", async () => {
  const { store } = backing();
  const admin = await key();
  const bad = await key();
  const salt = generateSaltHex();
  await makeStore(store, bad, PASSWORD, salt).publish("shared", "settings", { x: 1 }, 1);

  const registry = await signTrustRegistry(admin, 1, [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
    { deviceId: bad.deviceId, publicKeyHex: bad.publicKeyHex, role: "revoked" },
  ] as TrustEntry[]);

  const read = await makeStore(store, admin, PASSWORD, salt).read("shared", "settings", registry);
  assert.equal(read.kind === "rejected" && read.rejection.code, "revoked-signer");
});

test("mutating the stored envelope invalidates the signature", async () => {
  const { store } = backing();
  const k = await key();
  const docs = makeStore(store, k);
  await docs.publish("shared", "settings", { x: 1 }, 1);

  const objectKey = documentKey(PREFIX, "shared", "settings");
  const got = await store.get(objectKey);
  const body = JSON.parse(got.text) as { envelope: Record<string, unknown> };
  body.envelope.revision = 9; // claim a newer revision than was signed
  await store.putCompareAndSwap(
    objectKey,
    new TextEncoder().encode(JSON.stringify(body)),
    got.etag,
  );

  const read = await docs.read("shared", "settings", await registryFor(k));
  assert.equal(read.kind === "rejected" && read.rejection.code, "bad-signature");
});

test("re-sealing different content under a valid signature is caught", async () => {
  const { store } = backing();
  const k = await key();
  const salt = generateSaltHex();
  const docs = makeStore(store, k, PASSWORD, salt);
  const objectKey = documentKey(PREFIX, "shared", "settings");

  // Revision 1 holds the content we will try to roll back to, so capture its
  // payload before it is replaced.
  await docs.publish("shared", "settings", { role: "viewer" }, 1);
  const rev1 = JSON.parse((await store.get(objectKey)).text) as Record<string, unknown>;

  await docs.publish("shared", "settings", { role: "admin" }, 2);
  const rev2 = JSON.parse((await store.get(objectKey)).text) as Record<string, unknown>;

  // Graft revision 1's payload onto revision 2's envelope. The AEAD context is
  // identical (same scope, name and device), so decryption SUCCEEDS — only the
  // hash the envelope commits to catches this. Without it, a password holder
  // could roll a document back to older content while presenting a newer,
  // validly-signed envelope, and the rollback guard would see nothing wrong.
  const spliced = { ...rev2, payload: rev1.payload };
  const fresh = await store.get(objectKey);
  await store.putCompareAndSwap(
    objectKey,
    new TextEncoder().encode(JSON.stringify(spliced)),
    fresh.etag,
  );

  const read = await docs.read("shared", "settings", await registryFor(k));
  assert.equal(read.kind, "rejected");
  if (read.kind !== "rejected") return;
  assert.equal(read.rejection.code, "hash-mismatch");
});

test("a payload lifted from a different document is refused by the context binding", async () => {
  const { store } = backing();
  const k = await key();
  const salt = generateSaltHex();
  const docs = makeStore(store, k, PASSWORD, salt);
  await docs.publish("shared", "settings", { role: "viewer" }, 1);
  await docs.publish("shared", "scratch", { role: "admin" }, 1);

  const settingsKey = documentKey(PREFIX, "shared", "settings");
  const original = JSON.parse((await store.get(settingsKey)).text) as Record<string, unknown>;
  const other = JSON.parse(
    (await store.get(documentKey(PREFIX, "shared", "scratch"))).text,
  ) as Record<string, unknown>;

  const spliced = { ...original, payload: other.payload };
  const fresh = await store.get(settingsKey);
  await store.putCompareAndSwap(
    settingsKey,
    new TextEncoder().encode(JSON.stringify(spliced)),
    fresh.etag,
  );

  // The payload was sealed against `doc:shared::scratch`, so opening it as
  // `settings` fails the additional-data check before any content is returned.
  const read = await docs.read("shared", "settings", await registryFor(k));
  assert.equal(read.kind === "rejected" && read.rejection.code, "decrypt");
});

test("a wrong password rejects without revealing anything", async () => {
  const { store } = backing();
  const k = await key();
  const salt = generateSaltHex();
  await makeStore(store, k, PASSWORD, salt).publish("shared", "settings", { x: 1 }, 1);

  const read = await makeStore(store, k, "wrong-password", salt).read(
    "shared",
    "settings",
    await registryFor(k),
  );
  assert.equal(read.kind === "rejected" && read.rejection.code, "decrypt");
  assert.ok(!JSON.stringify(read).includes(PASSWORD));
});

test("a fresh device with a different salt still reads, because the salt travels", async () => {
  const { store } = backing();
  const a = await key();
  const b = await key();
  await makeStore(store, a, PASSWORD, generateSaltHex()).publish(
    "shared",
    "settings",
    { theme: "dark" },
    1,
  );

  // B derives its OWN salt locally, which is irrelevant for reading: the KDF salt
  // is carried in the authenticated envelope header.
  const read = await makeStore(store, b, PASSWORD, generateSaltHex()).read<{ theme: string }>(
    "shared",
    "settings",
    await registryFor(a, b),
  );
  assert.equal(read.kind, "loaded");
  if (read.kind === "loaded") assert.equal(read.document.value.theme, "dark");
});

test("replaying an older revision is refused by rollback protection", async () => {
  const { store } = backing();
  const k = await key();
  const docs = makeStore(store, k);
  const registry = await registryFor(k);
  await docs.publish("shared", "settings", { v: 1 }, 1);

  const read = await docs.read("shared", "settings", registry, { lastAppliedRevision: 5 });
  assert.equal(read.kind === "rejected" && read.rejection.code, "rollback");
});

// ── scoping ──────────────────────────────────────────────────────────────────

test("device documents are per device and do not collide", async () => {
  const { store } = backing();
  const a = await key();
  const b = await key();
  const salt = generateSaltHex();
  const docsA = makeStore(store, a, PASSWORD, salt);
  const docsB = makeStore(store, b, PASSWORD, salt);
  const registry = await registryFor(a, b);

  await docsA.publish("device", "workspaces", { folders: ["/Users/alice/work"] }, 1);
  await docsB.publish("device", "workspaces", { folders: ["D:\\\\projects"] }, 1);

  const mine = await docsA.read<{ folders: string[] }>("device", "workspaces", registry);
  assert.equal(mine.kind, "loaded");
  if (mine.kind === "loaded") assert.deepEqual(mine.document.value.folders, ["/Users/alice/work"]);

  // A device can read another device's backup explicitly, which is what a
  // cross-device restore needs, but it is never the default.
  const theirs = await docsA.read<{ folders: string[] }>("device", "workspaces", registry, {
    deviceId: b.deviceId,
  });
  assert.equal(theirs.kind, "loaded");
  if (theirs.kind === "loaded") {
    assert.deepEqual(theirs.document.value.folders, ["D:\\\\projects"]);
    assert.equal(theirs.document.deviceId, b.deviceId);
  }
});

test("a shared and a device document of the same name are different objects", async () => {
  const { store } = backing();
  const k = await key();
  const docs = makeStore(store, k);
  const registry = await registryFor(k);

  await docs.publish("shared", "settings", { where: "shared" }, 1);
  await docs.publish("device", "settings", { where: "device" }, 1);

  const s = await docs.read<{ where: string }>("shared", "settings", registry);
  const d = await docs.read<{ where: string }>("device", "settings", registry);
  assert.equal(s.kind === "loaded" && s.document.value.where, "shared");
  assert.equal(d.kind === "loaded" && d.document.value.where, "device");
});

test("a device record moved into the shared slot is refused", async () => {
  const { store } = backing();
  const k = await key();
  const salt = generateSaltHex();
  const docs = makeStore(store, k, PASSWORD, salt);
  await docs.publish("device", "workspaces", { folders: ["/secret"] }, 1);

  // Copy the device record over the shared key. The envelope still says
  // scope=device, so the slot check refuses it before anything is decrypted.
  const from = await store.get(documentKey(PREFIX, "device", "workspaces", k.deviceId));
  await store.putCreate(
    documentKey(PREFIX, "shared", "workspaces"),
    new TextEncoder().encode(from.text),
  );

  const read = await docs.read("shared", "workspaces", await registryFor(k));
  assert.equal(read.kind === "rejected" && read.rejection.code, "id-mismatch");
});

test("malformed stored bytes are rejected rather than thrown", async () => {
  const { store } = backing();
  const k = await key();
  const docs = makeStore(store, k);
  await store.putCreate(
    documentKey(PREFIX, "shared", "settings"),
    new TextEncoder().encode("this is not a record"),
  );
  const read = await docs.read("shared", "settings", await registryFor(k));
  assert.equal(read.kind === "rejected" && read.rejection.code, "malformed");
});

test("an unsafe document name or missing deviceId is refused at the key layer", () => {
  assert.throws(() => documentKey(PREFIX, "shared", "../escape"), /invalid document name/);
  assert.throws(() => documentKey(PREFIX, "shared", "Upper"), /invalid document name/);
  assert.throws(() => documentKey(PREFIX, "device", "workspaces"), /requires a deviceId/);
});
