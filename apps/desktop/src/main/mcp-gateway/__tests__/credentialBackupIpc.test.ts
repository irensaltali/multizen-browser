import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import {
  MIN_BUNDLE_PASSPHRASE_LENGTH,
  type SyncObjectStore,
  type TrustEntry,
} from "@multizen/mcp-gateway";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { CredentialSync } from "../CredentialSync.ts";
import { GATEWAY_IPC_CHANNELS } from "../gatewayIpcChannels.ts";
import { registerGatewayHandlers, type IpcRegistrar } from "../registerGatewayHandlers.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

/**
 * The controller surface the settings UI talks to.
 *
 * The property under test throughout is that the passphrase moves in one
 * direction only: it can be set, and it can be used, but no method returns it and
 * no error message repeats it back.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";
const PASSPHRASE = "a sufficiently long bundle passphrase";
const EXCLUDED = ["kopiaPassword", "s3AccessKeyId", "s3SecretAccessKey"];

interface Device {
  svc: GatewayService;
  ctl: GatewayController;
  creds: CredentialSync;
  vault: MemoryVault;
  cleanup: () => void;
}

async function device(
  store: InMemoryConditionalObjectStore | null,
  vault = new MemoryVault(),
): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), "gw-credipc-"));
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
  const creds = new CredentialSync({
    service: svc,
    vault: svc.vaultAdapter,
    excludedNames: () => EXCLUDED,
  });
  const ctl = new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
    credentials: () => creds,
  });
  return { svc, ctl, creds, vault, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

async function seed(d: Device, projectId: string, envName: string): Promise<void> {
  assert.ok((await d.ctl.createProject({ id: projectId, enabled: true })).ok);
  assert.ok(
    (
      await d.ctl.addServer(projectId, {
        transport: "stdio",
        id: "srv",
        command: "echo",
        args: [],
        env: { TOKEN: `\${${envName}}` },
      })
    ).ok,
  );
}

// ── the view ────────────────────────────────────────────────────────────────

test("the backup view reports off, and reports the floor the backend enforces", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    const res = await a.ctl.credentialBackup();
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.enabled, false);
    assert.equal(res.value.syncing, true);
    assert.equal(res.value.remotePresent, false);
    // The renderer's strength gate reads its hard limit from here, so this must
    // be the very constant the enable path checks against.
    assert.equal(res.value.minPassphraseLength, MIN_BUNDLE_PASSPHRASE_LENGTH);
    // Exactly the documented keys — nothing secret can ride along.
    assert.deepEqual(Object.keys(res.value).sort(), [
      "enabled",
      "localCount",
      "minPassphraseLength",
      "remoteIssue",
      "remotePresent",
      "syncing",
    ]);
  } finally {
    a.cleanup();
  }
});

test("the view reports not-syncing rather than failing when Cloud Sync is absent", async () => {
  const a = await device(null);
  try {
    const res = await a.ctl.credentialBackup();
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.syncing, false);
    assert.equal(res.value.remotePresent, null);
  } finally {
    a.cleanup();
  }
});

test("the backup view composes document sync when Cloud Sync becomes ready later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-credipc-late-"));
  const store = new InMemoryConditionalObjectStore();
  let ready = false;
  const vault = new MemoryVault();
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
    syncMaterials: async () =>
      ready
        ? {
            store: store as unknown as SyncObjectStore,
            controlPrefix: PREFIX,
            password: PASSWORD,
            deviceId: "late-device",
          }
        : null,
  });
  await svc.start();
  const creds = new CredentialSync({
    service: svc,
    vault: svc.vaultAdapter,
    excludedNames: () => EXCLUDED,
  });
  let reconciled = 0;
  const reconcile = creds.reconcile.bind(creds);
  creds.reconcile = async () => {
    reconciled += 1;
    return reconcile();
  };
  const ctl = new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
    credentials: () => creds,
  });
  try {
    await svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    const before = await ctl.credentialBackup();
    assert.ok(before.ok);
    if (before.ok) assert.equal(before.value.syncing, false);

    ready = true;
    const after = await ctl.credentialBackup();
    assert.ok(after.ok);
    if (after.ok) {
      assert.equal(after.value.syncing, true);
      assert.equal(after.value.remotePresent, false);
      assert.equal(reconciled, 1, "an enabled backup is reconciled after late composition");
    }
  } finally {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a controller without a credential channel degrades instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-credipc-none-"));
  const svc = new GatewayService({
    dataDir: dir,
    vault: new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
  });
  await svc.start();
  // No `credentials` option at all, as when the gateway composed without a vault.
  const ctl = new GatewayController(svc, { baseUrl: svc.baseUrl, routesServed: () => true });
  try {
    const view = await ctl.credentialBackup();
    assert.ok(view.ok);
    if (view.ok) assert.equal(view.value.enabled, false);
    for (const res of [
      await ctl.enableCredentialBackup(PASSPHRASE),
      await ctl.disableCredentialBackup(),
      await ctl.restoreCredentials(PASSPHRASE),
    ]) {
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error.code, "unavailable");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the gate ────────────────────────────────────────────────────────────────

test("a passphrase below the floor is refused and never reaches the vault", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    const short = "x".repeat(MIN_BUNDLE_PASSPHRASE_LENGTH - 1);
    const res = await a.ctl.enableCredentialBackup(short);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "weak-passphrase");
      assert.match(res.error.message, /at least 12 characters/i);
      // The refusal must not quote the input back.
      assert.ok(!res.error.message.includes(short));
    }
    // The UI's own gate is advisory; this is the one that counts.
    assert.equal(await a.svc.vaultAdapter.hasBundlePassphrase(), false);
  } finally {
    a.cleanup();
  }
});

test("enabling without Cloud Sync explains what to do first and stores nothing", async () => {
  const a = await device(null);
  try {
    const res = await a.ctl.enableCredentialBackup(PASSPHRASE);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "not-syncing");
      assert.match(res.error.message, /Set up Cloud Sync/i);
    }
    // Rolled back, so the operator is not left enabled-but-unable-to-publish.
    assert.equal(await a.svc.vaultAdapter.hasBundlePassphrase(), false);
  } finally {
    a.cleanup();
  }
});

// ── the happy path and the state it produces ────────────────────────────────

test("enabling publishes and the view flips to on", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    await seed(a, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", "sk-canary-value");

    const res = await a.ctl.enableCredentialBackup(PASSPHRASE);
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.value.enabled, true);
    assert.equal(res.value.remotePresent, true);
    assert.equal(res.value.localCount, 1);
  } finally {
    a.cleanup();
  }
});

test("a second device with the wrong passphrase is told exactly what went wrong", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seed(a, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", "sk-canary-value");
    assert.ok((await a.ctl.enableCredentialBackup(PASSPHRASE)).ok);

    const res = await b.ctl.enableCredentialBackup("an entirely different passphrase");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "wrong-passphrase");
      // Actionable: it names both ways out rather than just failing.
      assert.match(res.error.message, /passphrase from the device that created it/i);
    }
    assert.equal(await b.svc.vaultAdapter.hasBundlePassphrase(), false);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("restore reports what it wrote, and a wrong passphrase as such", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seed(a, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", "sk-canary-value");
    assert.ok((await a.ctl.enableCredentialBackup(PASSPHRASE)).ok);
    await b.svc.syncNow();

    const wrong = await b.ctl.restoreCredentials("not the right passphrase");
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error.code, "wrong-passphrase");

    const right = await b.ctl.restoreCredentials(PASSPHRASE);
    assert.ok(right.ok, JSON.stringify(right));
    if (!right.ok) return;
    assert.deepEqual(right.value, { restored: 1, projects: ["proj1"] });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("restoring with nothing published says so instead of reporting a bad passphrase", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    const res = await a.ctl.restoreCredentials(PASSPHRASE);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "absent");
      assert.match(res.error.message, /no credential backup has been published/i);
    }
  } finally {
    a.cleanup();
  }
});

test("an empty restore passphrase is rejected before any work happens", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    const res = await a.ctl.restoreCredentials("");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "invalid");
  } finally {
    a.cleanup();
  }
});

test("disabling clears the stored copy but keeps local credentials", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    await seed(a, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", "sk-canary-value");
    assert.ok((await a.ctl.enableCredentialBackup(PASSPHRASE)).ok);

    const off = await a.ctl.disableCredentialBackup();
    assert.ok(off.ok);
    if (!off.ok) return;
    assert.equal(off.value.enabled, false);
    assert.equal(off.value.remotePresent, false);
    // Still usable locally: turning the backup off is not a delete.
    assert.equal(
      await a.svc.vaultAdapter.getManagedSecret("proj1", "UPSTREAM_TOKEN"),
      "sk-canary-value",
    );
    // And a later restore is honest about there being nothing stored.
    const res = await a.ctl.restoreCredentials(PASSPHRASE);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "absent");
  } finally {
    a.cleanup();
  }
});

// ── write-only, structurally ────────────────────────────────────────────────

test("the registered channels are exactly the declared allowlist", async () => {
  // Registration drives the assertion, so a handler added without listing it (or
  // listed without being added) fails here. That is what makes the absence of a
  // passphrase reader a checked property rather than a convention.
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    const registered: string[] = [];
    const recorder: IpcRegistrar = {
      handle: (channel) => {
        assert.ok(!registered.includes(channel), `channel ${channel} registered twice`);
        registered.push(channel);
      },
    };
    registerGatewayHandlers(recorder, a.ctl, {
      pickDirectory: async () => null,
      revealPath: () => undefined,
    });
    assert.deepEqual([...registered].sort(), [...GATEWAY_IPC_CHANNELS].sort());
  } finally {
    a.cleanup();
  }
});

test("no IPC channel or controller method can read a passphrase back", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await device(store);
  try {
    await trust(a);
    await a.ctl.enableCredentialBackup(PASSPHRASE);

    // The channel list is the allowlist the preload bridge mirrors. A reader
    // would have to be added here first, so pinning it is what keeps the
    // write-only property from being lost by accident.
    const credentialChannels = GATEWAY_IPC_CHANNELS.filter((c) => /credential/i.test(c));
    assert.deepEqual(credentialChannels, [
      "gateway:credentialBackup",
      "gateway:enableCredentialBackup",
      "gateway:disableCredentialBackup",
      "gateway:replaceCredentialBackup",
      "gateway:restoreCredentials",
    ]);

    // Nothing the controller can return mentions the passphrase.
    const responses = JSON.stringify([
      await a.ctl.credentialBackup(),
      await a.ctl.restoreCredentials("wrong on purpose"),
      await a.ctl.replaceCredentialBackup(),
      await a.ctl.disableCredentialBackup(),
      await a.ctl.enableCredentialBackup("x"),
    ]);
    assert.ok(!responses.includes(PASSPHRASE));
    assert.ok(!responses.includes("wrong on purpose"));
  } finally {
    a.cleanup();
  }
});
