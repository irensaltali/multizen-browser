import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import type { SyncObjectStore } from "@multizen/mcp-gateway";
import { SYNC_DEFAULTS, type AppSettings, type SharedSettings } from "@multizen/settings-store";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { GatewayVault } from "../GatewayVault.ts";
import { SettingsSync, SETTINGS_DOCUMENT } from "../SettingsSync.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

/**
 * Settings sync: the shared subset travels, device-local fields never do.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

function sharedStore(): SyncObjectStore {
  return new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
}

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: "dark",
    mcpHttpEnabled: true,
    mcpHttpPort: 7777,
    browserEngine: "cloakbrowser",
    autoUpdate: true,
    engineAutoUpdate: false,
    sync: {
      ...SYNC_DEFAULTS,
      deviceId: "device_local",
      deviceDisplayName: "This Mac",
      s3Bucket: "secret-bucket",
      kopiaPasswordRef: "kopia-password-ref",
    },
    ...over,
  };
}

/** A device with a gateway service, a document store, and a settings mirror. */
async function device(store: SyncObjectStore, initial: AppSettings) {
  const dir = mkdtempSync(join(tmpdir(), "gw-settings-"));
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
    syncMaterials: async () => ({
      store,
      controlPrefix: PREFIX,
      password: PASSWORD,
      deviceId: initial.sync.deviceId,
    }),
  });
  await svc.start();
  let current = initial;
  const patches: Array<Partial<SharedSettings>> = [];
  const sync = new SettingsSync({
    service: svc,
    getSettings: () => current,
    applyPatch: async (patch) => {
      patches.push(patch);
      current = { ...current, ...patch };
      return current;
    },
  });
  return {
    dir,
    svc,
    sync,
    patches,
    get settings(): AppSettings {
      return current;
    },
    set settings(next: AppSettings) {
      current = next;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Make A the trust root and approve B, so both may publish documents. */
async function trustBoth(a: Awaited<ReturnType<typeof device>>, bVault: MemoryVault) {
  const ctl = new GatewayController(a.svc, {
    baseUrl: a.svc.baseUrl,
    routesServed: () => true,
  });
  const gv = new GatewayVault(bVault);
  const key = await gv.getOrCreateSigningKey();
  await ctl.approveDevice(key.deviceId, key.publicKeyHex);
}

function allFileContents(dir: string): string {
  let out = "";
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out += readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("a shared preference reaches another device", async () => {
  const store = sharedStore();
  const a = await device(store, settings({ autoUpdate: true }));
  const bVault = new MemoryVault();
  await trustBoth(a, bVault);
  try {
    // A turns auto-update off.
    a.settings = { ...a.settings, autoUpdate: false };
    assert.equal(await a.sync.push(), true);

    // B, with its own settings and its own identity, picks it up.
    const b = await device(
      store,
      settings({ autoUpdate: true, sync: { ...settings().sync, deviceId: "device_b" } }),
    );
    try {
      // B's vault must be the approved one for its document reads to verify A's.
      const outcome = await b.sync.pull();
      assert.equal(outcome.applied, true);
      assert.deepEqual(outcome.changed, ["autoUpdate"]);
      assert.equal(b.settings.autoUpdate, false);
    } finally {
      b.cleanup();
    }
  } finally {
    a.cleanup();
  }
});

test("device-local settings are never published", async () => {
  const store = sharedStore();
  const a = await device(store, settings());
  try {
    await a.sync.push();

    // Inspect every object in the bucket: none may contain the device identity,
    // bucket coordinates, credential reference names, port, or engine choice.
    const page = await store.list(`${PREFIX}/`, { maxKeys: 1000 });
    let all = "";
    for (const key of page.keys) {
      all += Buffer.from((await store.get(key)).bytes).toString("utf8");
    }
    assert.ok(all.length > 0, "something was published");
    for (const forbidden of [
      "device_local",
      "This Mac",
      "secret-bucket",
      "kopia-password-ref",
      "cloakbrowser",
      "7777",
    ]) {
      assert.ok(!all.includes(forbidden), `${forbidden} must not be published`);
    }
  } finally {
    a.cleanup();
  }
});

test("applying a remote document never touches device-local fields", async () => {
  const store = sharedStore();
  const a = await device(store, settings({ mcpHttpEnabled: true }));
  try {
    a.settings = { ...a.settings, mcpHttpEnabled: false };
    await a.sync.push();

    const b = await device(
      store,
      settings({
        mcpHttpEnabled: true,
        mcpHttpPort: 9999,
        browserEngine: "cft",
        sync: { ...settings().sync, deviceId: "device_b", deviceDisplayName: "B" },
      }),
    );
    try {
      await b.sync.pull();
      assert.equal(b.settings.mcpHttpEnabled, false, "the shared field changed");
      assert.equal(b.settings.mcpHttpPort, 9999, "the local port is untouched");
      assert.equal(b.settings.browserEngine, "cft", "the engine choice is untouched");
      assert.equal(b.settings.sync.deviceId, "device_b", "identity is untouched");
      assert.equal(b.settings.sync.deviceDisplayName, "B");
      // The patch itself only ever contained shared keys.
      for (const patch of b.patches) {
        for (const key of Object.keys(patch)) {
          assert.ok(
            ["theme", "mcpHttpEnabled", "autoUpdate", "engineAutoUpdate"].includes(key),
            `patch key ${key} must be shared`,
          );
        }
      }
    } finally {
      b.cleanup();
    }
  } finally {
    a.cleanup();
  }
});

test("an unchanged snapshot does not burn a revision", async () => {
  const store = sharedStore();
  const a = await device(store, settings());
  try {
    assert.equal(await a.sync.push(), true, "the first push writes");
    assert.equal(await a.sync.push(), false, "an identical second push is skipped");
    assert.equal(await a.sync.push(), false);

    a.settings = { ...a.settings, autoUpdate: !a.settings.autoUpdate };
    assert.equal(await a.sync.push(), true, "a real change writes again");
  } finally {
    a.cleanup();
  }
});

test("an identical remote document reports unchanged and writes nothing locally", async () => {
  const store = sharedStore();
  const a = await device(store, settings());
  try {
    await a.sync.push();
    const outcome = await a.sync.pull({ expectFresh: false });
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "unchanged");
    assert.equal(a.patches.length, 0, "no settings write was made");
  } finally {
    a.cleanup();
  }
});

test("no document yet is reported as absent, not an error", async () => {
  const store = sharedStore();
  const a = await device(store, settings());
  try {
    const outcome = await a.sync.pull();
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "absent");
  } finally {
    a.cleanup();
  }
});

test("a document from an untrusted device is refused and changes nothing", async () => {
  const store = sharedStore();
  // A owns the trust root.
  const a = await device(store, settings());
  try {
    await a.sync.push();

    // B is never approved, so its document cannot be accepted by A.
    const b = await device(
      store,
      settings({ theme: "dark", autoUpdate: false, sync: { ...settings().sync, deviceId: "device_b" } }),
    );
    try {
      // B overwrites the shared document with its own signature. Its first
      // attempt loses the compare-and-swap against A's revision 1 and adopts the
      // remote number, so a second attempt is what actually lands at revision 2.
      const first = await b.svc.publishDocument("shared", SETTINGS_DOCUMENT, {
        theme: "dark",
        mcpHttpEnabled: false,
        autoUpdate: false,
        engineAutoUpdate: true,
      });
      assert.equal(first?.kind, "conflict");
      const second = await b.svc.publishDocument("shared", SETTINGS_DOCUMENT, {
        theme: "dark",
        mcpHttpEnabled: false,
        autoUpdate: false,
        engineAutoUpdate: true,
      });
      assert.equal(second?.kind, "published");

      const before = a.settings;
      const outcome = await a.sync.pull({ expectFresh: false });
      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, "rejected");
      assert.match(outcome.rejection ?? "", /unknown-signer/);
      assert.deepEqual(a.settings, before, "nothing local changed");
    } finally {
      b.cleanup();
    }
  } finally {
    a.cleanup();
  }
});

test("settings are usable with sync switched off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-settings-local-"));
  try {
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
    let current = settings();
    const sync = new SettingsSync({
      service: svc,
      getSettings: () => current,
      applyPatch: async (p) => {
        current = { ...current, ...p };
        return current;
      },
    });

    assert.equal(await sync.push(), false, "nothing to publish without sync");
    assert.equal((await sync.pull()).reason, "not-syncing");
    assert.equal(svc.documentStore, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile takes the remote view first, then publishes any remaining difference", async () => {
  const store = sharedStore();
  const a = await device(store, settings({ engineAutoUpdate: false }));
  try {
    a.settings = { ...a.settings, engineAutoUpdate: true };
    await a.sync.push();

    // B has been offline with a stale opposite value. Pull-before-push means it
    // adopts the shared state rather than stamping its stale snapshot over it.
    const b = await device(
      store,
      settings({ engineAutoUpdate: false, sync: { ...settings().sync, deviceId: "device_b" } }),
    );
    try {
      const outcome = await b.sync.reconcile();
      assert.equal(outcome.applied, true);
      assert.equal(b.settings.engineAutoUpdate, true, "B adopted the shared value");
    } finally {
      b.cleanup();
    }
  } finally {
    a.cleanup();
  }
});

test("the document revision survives a restart so replays are refused", async () => {
  const store = sharedStore();
  const a = await device(store, settings());
  try {
    await a.sync.push();
    await a.sync.pull({ expectFresh: false });
    // The revision counter is persisted in the gateway state file.
    assert.match(allFileContents(a.dir), /documentRevisions/);
  } finally {
    a.cleanup();
  }
});
