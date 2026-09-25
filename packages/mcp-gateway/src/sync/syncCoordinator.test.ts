import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";

import { assertProjectId } from "../ids.js";
import { CONFIG_VERSION, parseProjectConfig, type ProjectConfig } from "../projectConfig.js";
import {
  signTrustRegistry,
  type TrustEntry,
  type TrustRegistry,
} from "../trust.js";
import { InMemoryVault, type SigningKey } from "../vault.js";
import { generateSaltHex } from "./crypto.js";
import { projectStateKey } from "./keys.js";
import { decodeRecord } from "./projectRecord.js";
import {
  ProjectSyncCoordinator,
  type ConflictOutcome,
  type PublishOutcome,
} from "./syncCoordinator.js";

const PASSWORD = "operator-password-🔐";
const PREFIX = "repo";

async function key(): Promise<SigningKey> {
  return new InMemoryVault().getOrCreateSigningKey();
}

function trustedRegistry(k: SigningKey, extra: TrustEntry[] = []): Promise<TrustRegistry> {
  return signTrustRegistry(k, 1, [
    { deviceId: k.deviceId, publicKeyHex: k.publicKeyHex, role: "trusted" },
    ...extra,
  ]);
}

function cfg(id: string, opts: { enabled?: boolean; browserProfileId?: string } = {}): ProjectConfig {
  return parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id,
    enabled: opts.enabled ?? true,
    ...(opts.browserProfileId ? { browserProfileId: opts.browserProfileId } : {}),
    servers: [
      { transport: "stdio", id: "s", command: "node", args: ["x.js"], env: { TOKEN: "${TOK}" } },
    ],
  });
}

function makeCoordinator(store: InMemoryConditionalObjectStore, k: SigningKey, salt: string) {
  return new ProjectSyncCoordinator({
    store,
    controlPrefix: PREFIX,
    password: PASSWORD,
    saltHex: salt,
    signingKey: k,
  });
}

test("device A publish → device B fresh-device restore (all projects)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const kA = await key();
  const registry = await trustedRegistry(kA);
  const coordA = makeCoordinator(store, kA, salt);

  const r1 = await coordA.publish(cfg("alpha"), 1);
  const r2 = await coordA.publish(cfg("beta", { enabled: false }), 1);
  assert.equal(r1.kind, "published");
  assert.equal(r2.kind, "published");

  // Fresh device B: only password + salt + signed registry, no shared state.
  const kB = await key();
  const coordB = new ProjectSyncCoordinator({
    store,
    controlPrefix: PREFIX,
    password: PASSWORD,
    saltHex: salt,
    signingKey: kB,
  });
  const restored = await coordB.restoreAll(registry);
  assert.equal(restored.quarantined.length, 0);
  const ids = restored.applied.map((a) => a.projectId).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
});

test("disabled project remains disabled after restore (exact desired state)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("gamma", { enabled: false }), 1);
  const restored = await coord.restoreAll(registry);
  const gamma = restored.applied.find((a) => a.projectId === "gamma");
  assert.ok(gamma);
  assert.equal(gamma!.config.enabled, false);
  assert.equal(gamma!.config.servers[0]!.disabled, false); // exact desired state preserved
});

test("bound and unbound projects sync identically", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("bound", { browserProfileId: "profile-1" }), 1);
  await coord.publish(cfg("unbound"), 1);
  const restored = await coord.restoreAll(registry);
  const bound = restored.applied.find((a) => a.projectId === "bound");
  const unbound = restored.applied.find((a) => a.projectId === "unbound");
  assert.equal(bound!.config.browserProfileId, "profile-1");
  assert.equal(unbound!.config.browserProfileId, undefined);
});

test("monotonic revision: contiguous publish advances head; history is written", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("proj"), 1);
  const r2 = (await coord.publish(cfg("proj", { enabled: false }), 2)) as PublishOutcome;
  assert.equal(r2.kind, "published");
  assert.equal(r2.revision, 2);
  // Immutable history for both revisions exists.
  assert.ok(store.has("repo/mcp/projects/proj/rev/1.json"));
  assert.ok(store.has("repo/mcp/projects/proj/rev/2.json"));
});

test("first publish must be revision 1; non-contiguous rejected", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const coord = makeCoordinator(store, k, salt);
  await assert.rejects(() => coord.publish(cfg("p"), 2));
  await coord.publish(cfg("p"), 1);
  await assert.rejects(() => coord.publish(cfg("p"), 3)); // skips 2
});

test("CAS conflict: concurrent update preserves both, no overwrite", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const kA = await key();
  const kB = await key();
  // Both devices are trusted so both configs are individually valid.
  const coordA = makeCoordinator(store, kA, salt);
  const coordB = makeCoordinator(store, kB, salt);

  await coordA.publish(cfg("proj"), 1); // head at rev 1 (signer A)

  // A advances to rev 2 first.
  const a2 = (await coordA.publish(cfg("proj", { enabled: false }), 2)) as PublishOutcome;
  assert.equal(a2.kind, "published");

  // B, having only seen rev 1, also tries rev 2 → loses; keep both.
  const b2 = (await coordB.publish(cfg("proj"), 2)) as ConflictOutcome;
  assert.equal(b2.kind, "conflict");
  assert.equal(b2.attemptedRevision, 2);
  assert.equal(b2.remoteRevision, 2);
  assert.equal(b2.metadata.localSigner, kB.deviceId);
  // The remote head is UNCHANGED (A's rev 2), never overwritten by B.
  const headBytes = (await store.get(projectStateKey(PREFIX, "proj"))).bytes;
  const head = decodeRecord(headBytes);
  assert.equal(head.envelope.signer, kA.deviceId);
  assert.equal(head.envelope.revision, 2);
  // The losing local config is returned for a durable local conflict copy.
  assert.equal(b2.losingConfig.id, "proj");
  assert.equal(b2.losingEnvelope.signer, kB.deviceId);
});

test("CAS race via barrier: interleaved rev-2 publishes keep both", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const kA = await key();
  const coordA = makeCoordinator(store, kA, salt);
  await coordA.publish(cfg("proj"), 1);

  // Park B's CAS write until A completes its own rev-2 CAS.
  const kB = await key();
  const coordB = makeCoordinator(store, kB, salt);
  const gate = store.gate("put", (key) => key.endsWith("proj/state.json"));
  const bPromise = coordB.publish(cfg("proj", { enabled: false }), 2);
  await gate.reached;
  // While B is parked, A publishes rev 2 successfully.
  const a2 = (await coordA.publish(cfg("proj"), 2)) as PublishOutcome;
  assert.equal(a2.kind, "published");
  gate.release();
  const b2 = (await bPromise) as ConflictOutcome;
  assert.equal(b2.kind, "conflict");
});

test("invalid signature quarantined on restore", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("proj"), 1);
  // Corrupt the signature in the stored head.
  const headKey = projectStateKey(PREFIX, "proj");
  const rec = decodeRecord((await store.get(headKey)).bytes);
  const forged = {
    recordVersion: rec.recordVersion,
    envelope: { ...rec.envelope, signature: "00".repeat(64) },
    payload: rec.payload,
  };
  const forgedBytes = new TextEncoder().encode(JSON.stringify(forged));
  const etag = (await store.get(headKey)).etag;
  await store.putCompareAndSwap(headKey, forgedBytes, etag);

  const restored = await coord.restoreAll(registry);
  assert.equal(restored.applied.length, 0);
  assert.equal(restored.quarantined.length, 1);
  assert.equal(restored.quarantined[0]!.code, "bad-signature");
});

test("unknown + revoked signer quarantined", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const admin = await key();
  const stranger = await key();
  const revoked = await key();

  // Publish "unknownproj" signed by a stranger not in the registry.
  await makeCoordinator(store, stranger, salt).publish(cfg("unknownproj"), 1);
  // Publish "revokedproj" signed by a device that the registry marks revoked.
  await makeCoordinator(store, revoked, salt).publish(cfg("revokedproj"), 1);

  const registry = await signTrustRegistry(admin, 2, [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
    { deviceId: revoked.deviceId, publicKeyHex: revoked.publicKeyHex, role: "revoked" },
  ]);

  const coord = makeCoordinator(store, admin, salt);
  const restored = await coord.restoreAll(registry);
  assert.equal(restored.applied.length, 0);
  const byId = new Map(restored.quarantined.map((q) => [q.projectId, q.code]));
  assert.equal(byId.get("unknownproj"), "unknown-signer");
  assert.equal(byId.get("revokedproj"), "revoked-signer");
});

test("rollback (stale revision) quarantined via knownRevisions", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("proj"), 1);
  // Device already applied revision 5 → seeing rev 1 again is a rollback.
  const known = new Map<string, number>([["proj", 5]]);
  const restored = await coord.restoreAll(registry, known);
  assert.equal(restored.applied.length, 0);
  assert.equal(restored.quarantined[0]!.code, "rollback");
});

test("the already-applied current revision is idempotent, not a rollback", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("proj"), 1);

  const restored = await coord.restoreAll(registry, new Map<string, number>([["proj", 1]]));

  assert.equal(restored.quarantined.length, 0);
  assert.equal(restored.applied[0]?.revision, 1);
});

test("tamper/authentication failure on payload quarantined (decrypt code)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("proj"), 1);
  const headKey = projectStateKey(PREFIX, "proj");
  const rec = decodeRecord((await store.get(headKey)).bytes);
  // Flip a ciphertext byte: envelope signature still checks over the (unchanged)
  // hash, but decrypt fails → decrypt quarantine.
  const ct = Buffer.from(rec.payload.ciphertext, "base64");
  ct[0] = ct[0]! ^ 0xff;
  const tampered = {
    recordVersion: rec.recordVersion,
    envelope: rec.envelope,
    payload: { ...rec.payload, ciphertext: ct.toString("base64") },
  };
  const etag = (await store.get(headKey)).etag;
  await store.putCompareAndSwap(headKey, new TextEncoder().encode(JSON.stringify(tampered)), etag);
  const restored = await coord.restoreAll(registry);
  assert.equal(restored.quarantined[0]!.code, "decrypt");
});

test("partial malformed project does not abort the whole restore", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("good1"), 1);
  await coord.publish(cfg("good2"), 1);
  // Write a malformed head object directly under a valid-looking key.
  await store.putCreate(
    projectStateKey(PREFIX, "brokenproj"),
    new TextEncoder().encode("{ not valid json"),
  );
  const restored = await coord.restoreAll(registry);
  const okIds = restored.applied.map((a) => a.projectId).sort();
  assert.deepEqual(okIds, ["good1", "good2"]);
  assert.equal(restored.quarantined.length, 1);
  assert.equal(restored.quarantined[0]!.projectId, "brokenproj");
  assert.equal(restored.quarantined[0]!.code, "malformed");
});

test("wrong password on restore quarantines everything (never applies)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  await makeCoordinator(store, k, salt).publish(cfg("proj"), 1);
  const badPw = new ProjectSyncCoordinator({
    store,
    controlPrefix: PREFIX,
    password: "the-wrong-password",
    saltHex: salt,
    signingKey: k,
  });
  const restored = await badPw.restoreAll(registry);
  assert.equal(restored.applied.length, 0);
  assert.equal(restored.quarantined[0]!.code, "decrypt");
});

test("idempotent republish of same revision does not corrupt head", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  await coord.publish(cfg("proj"), 1);
  // Re-publishing revision 1 (already the head) is a no-overwrite conflict.
  const again = (await coord.publish(cfg("proj"), 1)) as ConflictOutcome;
  assert.equal(again.kind, "conflict");
  const restored = await coord.restoreAll(registry);
  assert.equal(restored.applied.length, 1);
  assert.equal(restored.applied[0]!.revision, 1);
});

test("no plaintext config leaks into stored bytes (secret canary)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const coord = makeCoordinator(store, k, salt);
  const secretMarker = "s-e-c-r-e-t-command-marker";
  const conf = parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id: "proj",
    servers: [{ transport: "stdio", id: "s", command: secretMarker, args: [], env: {} }],
  });
  await coord.publish(conf, 1);
  for (const k2 of store.keys()) {
    const text = store.rawText(k2) ?? "";
    assert.ok(!text.includes(secretMarker), `plaintext leaked in ${k2}`);
    assert.ok(!text.includes(PASSWORD), `password leaked in ${k2}`);
  }
});

test("restoreProject returns null for absent project", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = makeCoordinator(store, k, salt);
  const res = await coord.restoreProject(assertProjectId("missing"), registry);
  assert.equal(res, null);
});

test("pagination: many projects restore across pages", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = new ProjectSyncCoordinator({
    store,
    controlPrefix: PREFIX,
    password: PASSWORD,
    saltHex: salt,
    signingKey: k,
    listPageSize: 3, // force multiple pages
  });
  const n = 10;
  for (let i = 0; i < n; i++) {
    await coord.publish(cfg(`proj-${i}`), 1);
  }
  const restored = await coord.restoreAll(registry);
  assert.equal(restored.applied.length, n);
  assert.equal(restored.quarantined.length, 0);
});

test("scan cap bounds discovery work", async () => {
  const store = new InMemoryConditionalObjectStore();
  const salt = generateSaltHex();
  const k = await key();
  const registry = await trustedRegistry(k);
  const coord = new ProjectSyncCoordinator({
    store,
    controlPrefix: PREFIX,
    password: PASSWORD,
    saltHex: salt,
    signingKey: k,
    listPageSize: 5,
    maxScanKeys: 3,
  });
  for (let i = 0; i < 8; i++) await coord.publish(cfg(`proj-${i}`), 1);
  const restored = await coord.restoreAll(registry);
  assert.ok(restored.scanned <= 3, `scanned ${restored.scanned} must be capped at 3`);
});
