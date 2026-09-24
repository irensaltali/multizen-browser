import assert from "node:assert/strict";
import test from "node:test";

import { GatewayVault, projectTokenName } from "../GatewayVault.ts";
import { MemoryVault } from "./testSupport.ts";

test("signing key is created once, persisted, and stable across instances", async () => {
  const vault = new MemoryVault();
  const a = new GatewayVault(vault);
  const k1 = await a.getOrCreateSigningKey();
  const k2 = await a.getOrCreateSigningKey();
  assert.equal(k1.deviceId, k2.deviceId, "idempotent within an instance");

  // A fresh adapter over the same underlying vault re-derives the SAME identity.
  const b = new GatewayVault(vault);
  const k3 = await b.getOrCreateSigningKey();
  assert.equal(k3.deviceId, k1.deviceId, "stable across instances");
  assert.equal(k3.publicKeyHex, k1.publicKeyHex);
});

test("signing produces verifiable Ed25519 signatures without exposing the private key", async () => {
  const vault = new MemoryVault();
  const gv = new GatewayVault(vault);
  const key = await gv.getOrCreateSigningKey();
  const msg = new TextEncoder().encode("hello");
  const sig = await key.sign(msg);
  assert.match(sig, /^[0-9a-f]+$/, "hex signature");

  // The only stored material is a PKCS#8 PEM under the reserved name; no raw
  // private key hex is ever returned by the SigningKey surface.
  const dumped = vault.dump();
  const pemName = Object.keys(dumped).find((k) => k.includes("device-signing-key-pem"));
  assert.ok(pemName, "private key stored as PEM");
  assert.ok((dumped[pemName as string] ?? "").includes("PRIVATE KEY"), "stored as PKCS#8 PEM");
  // SigningKey exposes only deviceId/publicKeyHex/sign — no private field.
  assert.deepEqual(Object.keys(key).sort(), ["deviceId", "publicKeyHex", "sign"]);
});

test("salt is generated once and reused (fresh-device key re-derivation)", async () => {
  const vault = new MemoryVault();
  const gv = new GatewayVault(vault);
  const s1 = await gv.getOrCreateSaltHex();
  const s2 = await gv.getOrCreateSaltHex();
  assert.equal(s1, s2);
  assert.match(s1, /^[0-9a-f]{64}$/);
  const gv2 = new GatewayVault(vault);
  assert.equal(await gv2.getOrCreateSaltHex(), s1);
});

test("project tokens generate, report presence, and delete without leaking", async () => {
  const vault = new MemoryVault();
  const gv = new GatewayVault(vault);
  assert.equal(await gv.hasProjectToken("proj"), false);
  const token = await gv.generateProjectToken("proj");
  assert.match(token, /^[0-9a-f]{64}$/, "256-bit hex token");
  assert.equal(await gv.hasProjectToken("proj"), true);
  assert.equal(await gv.getProjectToken("proj"), token, "internal read matches");
  // Regenerating overwrites.
  const token2 = await gv.generateProjectToken("proj");
  assert.notEqual(token, token2);
  await gv.deleteProjectToken("proj");
  assert.equal(await gv.hasProjectToken("proj"), false);
  // Token stored under the reserved per-project name.
  assert.ok(projectTokenName("proj").startsWith("mcp-gateway:project-token:"));
});
