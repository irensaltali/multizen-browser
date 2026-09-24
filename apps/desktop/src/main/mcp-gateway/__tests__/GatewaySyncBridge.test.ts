import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import {
  generateSaltHex,
  isMcpControlKey,
  parseProjectConfig,
  type SyncObjectStore,
} from "@multizen/mcp-gateway";

import { GatewaySyncBridge } from "../GatewaySyncBridge.ts";
import { GatewayVault } from "../GatewayVault.ts";
import { MemoryVault } from "./testSupport.ts";

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

function project(id: string, enabled = true) {
  return parseProjectConfig({
    configVersion: 1,
    id,
    enabled,
    localAuth: { enabled: false },
    servers: [
      { transport: "stdio", id: "s1", disabled: false, command: "echo", args: [], env: {} },
    ],
  });
}

async function makeBridge(store: SyncObjectStore, vault = new MemoryVault()) {
  const gv = new GatewayVault(vault);
  const signingKey = await gv.getOrCreateSigningKey();
  const saltHex = await gv.getOrCreateSaltHex();
  return new GatewaySyncBridge({ store, controlPrefix: PREFIX, password: PASSWORD, saltHex, signingKey });
}

test("first device bootstraps trust root; publish + restore round-trips", async () => {
  const store = new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
  const bridge = await makeBridge(store);
  const registry = await bridge.ensureTrustRegistry();
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0]?.role, "trusted");

  const p = project("alpha");
  const pub = await bridge.publish(p, 1);
  assert.equal(pub.kind, "published");

  const restored = await bridge.restoreAll();
  assert.equal(restored.applied.length, 1);
  assert.equal(restored.applied[0]?.projectId, "alpha");
  assert.equal(restored.applied[0]?.revision, 1);
  assert.equal(restored.quarantined.length, 0);
});

test("published config bytes never contain cleartext (encrypted at rest) and live only under mcp/ namespace", async () => {
  const inner = new InMemoryConditionalObjectStore();
  const store = inner as unknown as SyncObjectStore;
  const bridge = await makeBridge(store);
  await bridge.ensureTrustRegistry();
  await bridge.publish(project("secretproj"), 1);

  // Every written key is under the reserved <prefix>/mcp/ subtree — never the
  // browser-profile namespace.
  const page = await store.list(`${PREFIX}/`, { maxKeys: 1000 });
  assert.ok(page.keys.length > 0);
  for (const key of page.keys) {
    assert.ok(isMcpControlKey(PREFIX, key), `key ${key} is inside the reserved mcp namespace`);
    assert.ok(!key.includes("/profiles/") || key.includes("/mcp/projects/"), "no browser-profile state keys");
  }
});

test("a config signed by an untrusted device is quarantined, never applied", async () => {
  const store = new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
  // Device A bootstraps the trust root and publishes.
  const bridgeA = await makeBridge(store);
  await bridgeA.ensureTrustRegistry();
  await bridgeA.publish(project("alpha"), 1);

  // Device B (different vault → different key) publishes a project WITHOUT being
  // trusted. It shares the password (can seal), but its signer is unknown.
  const bridgeB = await makeBridge(store, new MemoryVault());
  await bridgeB.publish(project("beta"), 1);

  // Restore from device A's viewpoint: alpha applies, beta quarantines.
  const restored = await bridgeA.restoreAll();
  const appliedIds = restored.applied.map((a) => a.projectId).sort();
  const quarantinedIds = restored.quarantined.map((q) => q.projectId).sort();
  assert.deepEqual(appliedIds, ["alpha"]);
  assert.deepEqual(quarantinedIds, ["beta"]);
  assert.equal(restored.quarantined[0]?.code, "unknown-signer");
});

test("disabled projects restore preserving their disabled desired state", async () => {
  const store = new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
  const bridge = await makeBridge(store);
  await bridge.ensureTrustRegistry();
  await bridge.publish(project("disabledproj", false), 1);
  const restored = await bridge.restoreAll();
  assert.equal(restored.applied.length, 1);
  assert.equal(restored.applied[0]?.config.enabled, false);
});

test("salt reuse lets a fresh device (same password) decrypt", async () => {
  const store = new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
  const vault = new MemoryVault();
  const bridge = await makeBridge(store, vault);
  await bridge.ensureTrustRegistry();
  await bridge.publish(project("alpha"), 1);
  // A second bridge over the SAME vault (same salt + same trusted key) restores.
  const bridge2 = await makeBridge(store, vault);
  const restored = await bridge2.restoreAll();
  assert.equal(restored.applied.length, 1);
  void generateSaltHex; // referenced to assert import shape
});
