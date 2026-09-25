import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG_VERSION, parseProjectConfig } from "./projectConfig.js";
import { assertProjectId } from "./ids.js";
import {
  evaluateProject,
  hashConfig,
  signProject,
  signTrustRegistry,
  verifyProject,
  verifyTrustRegistry,
  VerificationError,
  type TrustEntry,
} from "./trust.js";
import { InMemoryVault, type SigningKey } from "./vault.js";

async function makeKey(): Promise<SigningKey> {
  return new InMemoryVault().getOrCreateSigningKey();
}

/** Run `fn`, assert it threw a VerificationError, and return it. */
function catchVerification(fn: () => unknown): VerificationError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof VerificationError, `expected VerificationError, got ${err}`);
    return err;
  }
  throw new assert.AssertionError({ message: "Expected function to throw" });
}

function sampleConfig(id = "proj") {
  return parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id,
    servers: [{ transport: "stdio", id: "s", command: "node", args: [], env: {} }],
  });
}

test("vault never exposes private key material", async () => {
  const key = await makeKey();
  const serialized = JSON.stringify(key, Object.keys(key));
  assert.ok(!serialized.includes("PRIVATE"));
  // Only deviceId + publicKeyHex are enumerable data; sign is a function.
  assert.deepEqual(Object.keys(key).sort(), ["deviceId", "publicKeyHex", "sign"].sort());
});

test("sign + verify project round-trip", async () => {
  const key = await makeKey();
  const registry = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
  ]);
  verifyTrustRegistry(registry);
  const cfg = sampleConfig();
  const env = await signProject(key, assertProjectId("proj"), 5, cfg);
  const verified = verifyProject(env, cfg, registry, { lastAppliedRevision: 4 });
  assert.equal(verified.revision, 5);
  assert.equal(verified.signer, key.deviceId);
});

test("hash mismatch rejected (tampered config)", async () => {
  const key = await makeKey();
  const registry = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
  ]);
  const cfg = sampleConfig();
  const env = await signProject(key, assertProjectId("proj"), 1, cfg);
  const tampered = parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id: "proj",
    servers: [{ transport: "stdio", id: "s", command: "evil", args: [], env: {} }],
  });
  assert.notEqual(hashConfig(tampered), env.hash);
  const err = catchVerification(() => verifyProject(env, tampered, registry));
  assert.equal(err.code, "hash-mismatch");
});

test("bad signature rejected", async () => {
  const key = await makeKey();
  const registry = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
  ]);
  const cfg = sampleConfig();
  const env = await signProject(key, assertProjectId("proj"), 1, cfg);
  const forged = { ...env, signature: "00".repeat(64) };
  const err = catchVerification(() => verifyProject(forged, cfg, registry));
  assert.equal(err.code, "bad-signature");
});

test("unknown signer quarantined", async () => {
  const signer = await makeKey();
  const other = await makeKey();
  const registry = await signTrustRegistry(other, 1, [
    { deviceId: other.deviceId, publicKeyHex: other.publicKeyHex, role: "trusted" },
  ]);
  const cfg = sampleConfig();
  const env = await signProject(signer, assertProjectId("proj"), 1, cfg);
  const decision = evaluateProject(env, cfg, registry);
  assert.equal(decision.accepted, false);
  assert.equal(decision.error!.code, "unknown-signer");
});

test("revoked signer rejected", async () => {
  const signer = await makeKey();
  const admin = await makeKey();
  const entries: TrustEntry[] = [
    { deviceId: admin.deviceId, publicKeyHex: admin.publicKeyHex, role: "trusted" },
    { deviceId: signer.deviceId, publicKeyHex: signer.publicKeyHex, role: "revoked" },
  ];
  const registry = await signTrustRegistry(admin, 2, entries);
  verifyTrustRegistry(registry);
  const cfg = sampleConfig();
  const env = await signProject(signer, assertProjectId("proj"), 1, cfg);
  const err = catchVerification(() => verifyProject(env, cfg, registry));
  assert.equal(err.code, "revoked-signer");
});

test("rollback (stale revision) rejected", async () => {
  const key = await makeKey();
  const registry = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
  ]);
  const cfg = sampleConfig();
  const env = await signProject(key, assertProjectId("proj"), 3, cfg);
  const err = catchVerification(() => verifyProject(env, cfg, registry, { lastAppliedRevision: 4 }));
  assert.equal(err.code, "rollback");
});

test("trust registry self-verification requires trusted signer", async () => {
  const key = await makeKey();
  const good = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
  ]);
  verifyTrustRegistry(good);

  const bad = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "revoked" },
  ]);
  const err = catchVerification(() => verifyTrustRegistry(bad));
  assert.equal(err.code, "revoked-signer");
});

test("registry with tampered signature rejected", async () => {
  const key = await makeKey();
  const reg = await signTrustRegistry(key, 1, [
    { deviceId: key.deviceId, publicKeyHex: key.publicKeyHex, role: "trusted" },
  ]);
  const forged = { ...reg, signature: "00".repeat(64) };
  const err = catchVerification(() => verifyTrustRegistry(forged));
  assert.equal(err.code, "bad-signature");
});

test("deterministic signing across two vaults with same seed", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const kp = generateKeyPairSync("ed25519");
  const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const v1 = new InMemoryVault({ privateKeyPem: pem });
  const v2 = new InMemoryVault({ privateKeyPem: pem });
  const k1 = await v1.getOrCreateSigningKey();
  const k2 = await v2.getOrCreateSigningKey();
  assert.equal(k1.deviceId, k2.deviceId);
  assert.equal(k1.publicKeyHex, k2.publicKeyHex);
  const cfg = sampleConfig();
  const e1 = await signProject(k1, assertProjectId("proj"), 1, cfg);
  const e2 = await signProject(k2, assertProjectId("proj"), 1, cfg);
  assert.equal(e1.signature, e2.signature);
});
