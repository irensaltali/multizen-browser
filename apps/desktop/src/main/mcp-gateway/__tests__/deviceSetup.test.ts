import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import type { SyncObjectStore, TrustEntry } from "@multizen/mcp-gateway";

import { BindingsSync } from "../BindingsSync.ts";
import { CredentialSync } from "../CredentialSync.ts";
import { DeviceSetup, SETUP_STAGES, type CloudSyncPort, type SetupStageState } from "../DeviceSetup.ts";
import { GatewayController } from "../GatewayController.ts";
import { GatewayService } from "../GatewayService.ts";
import { SettingsSync } from "../SettingsSync.ts";
import { projectSecretName } from "../GatewayVault.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

import type { AppSettings } from "@multizen/settings-store";
import type { BootstrapSummary, StorageTestResult, SyncConfigView } from "../../sync/types.ts";

/**
 * Setting up a replacement machine, end to end, against one in-memory bucket.
 *
 * The flow is only worth having if it is honest about partial success, so most of
 * these tests are about what it reports when something is missing rather than the
 * all-green path.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";
const PASSPHRASE = "a sufficiently long bundle passphrase";
const SECRET_VALUE = "sk-canary-upstream-key";
const EXCLUDED = ["kopiaPassword", "s3AccessKeyId", "s3SecretAccessKey"];

function settings(): AppSettings {
  return {
    theme: "dark",
    browserEngine: "cloakbrowser",
    mcpHttpEnabled: false,
    mcpHttpPort: 7777,
    autoUpdate: true,
    engineAutoUpdate: true,
    sync: {
      enabled: false,
      s3Endpoint: "",
      s3Region: "auto",
      s3Bucket: "",
      s3Prefix: "",
      controlPrefix: "control",
      s3ForcePathStyle: false,
      leaseTtlMs: 60_000,
      renewalMs: 15_000,
      clockSkewSafetyMs: 10_000,
      deviceId: "device_test",
      deviceDisplayName: "Test Mac",
      kopiaPasswordRef: "kopiaPassword",
      s3AccessKeyIdRef: "s3AccessKeyId",
      s3SecretAccessKeyRef: "s3SecretAccessKey",
      kopiaConfigPath: "",
      kopiaBinPath: "",
    },
  } as AppSettings;
}

/**
 * A fake Cloud Sync. Records what the flow asked for, so the order of operations
 * is observable, and lets each call be made to fail independently.
 */
class FakeCloud implements CloudSyncPort {
  readonly calls: string[] = [];
  readonly savedSecrets: Array<{ kind: string; value: string }> = [];
  config: Partial<SyncConfigView> = {};
  probe: StorageTestResult = {
    healthy: true,
    capability: { ok: true, failedCheck: null, message: null },
    conditionalWritesSupported: true,
  };
  bootstrap: BootstrapSummary = {
    phase: "done",
    running: false,
    startedAt: null,
    finishedAt: null,
    remoteDiscovered: 2,
    restored: 2,
    uploaded: 0,
    deferred: 0,
    reconciled: 0,
    failed: 0,
    remoteTruncated: false,
    results: [],
    error: null,
  };
  syncAllThrows: Error | null = null;

  async updateConfig(patch: Partial<SyncConfigView>): Promise<SyncConfigView> {
    this.calls.push("updateConfig");
    this.config = { ...this.config, ...patch };
    return this.config as SyncConfigView;
  }
  async saveSecret(kind: string, value: string): Promise<void> {
    this.calls.push(`saveSecret:${kind}`);
    this.savedSecrets.push({ kind, value });
  }
  async testStorageCoordination(opts?: {
    scheduleBootstrap?: boolean;
  }): Promise<StorageTestResult> {
    this.calls.push(`probe:scheduleBootstrap=${String(opts?.scheduleBootstrap)}`);
    return this.probe;
  }
  async syncAll(): Promise<BootstrapSummary> {
    this.calls.push("syncAll");
    if (this.syncAllThrows) throw this.syncAllThrows;
    return this.bootstrap;
  }
}

interface Device {
  svc: GatewayService;
  ctl: GatewayController;
  cloud: FakeCloud;
  setup: DeviceSetup;
  creds: CredentialSync;
  bindings: BindingsSync;
  vault: MemoryVault;
  progress: SetupStageState[];
  dir: string;
  cleanup: () => void;
}

async function device(
  store: InMemoryConditionalObjectStore,
  vault = new MemoryVault(),
  opts: { password?: string } = {},
): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), "gw-setup-"));
  const svc = new GatewayService({
    dataDir: dir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    deviceName: "Bea's laptop",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
    syncMaterials: async () => ({
      store: store as unknown as SyncObjectStore,
      controlPrefix: PREFIX,
      password: opts.password ?? PASSWORD,
      deviceId: "d",
    }),
  });
  await svc.start();
  const ctl = new GatewayController(svc, { baseUrl: svc.baseUrl, routesServed: () => true });
  const cloud = new FakeCloud();
  let live = settings();
  const creds = new CredentialSync({
    service: svc,
    vault: svc.vaultAdapter,
    excludedNames: () => EXCLUDED,
  });
  const bindings = new BindingsSync({ service: svc });
  const progress: SetupStageState[] = [];
  const setup = new DeviceSetup({
    cloud,
    service: svc,
    settings: new SettingsSync({
      service: svc,
      getSettings: () => live,
      applyPatch: async (patch) => {
        live = { ...live, ...patch } as AppSettings;
        return live;
      },
    }),
    bindings,
    credentials: creds,
    onStage: (s) => progress.push(s),
  });
  return {
    svc,
    ctl,
    cloud,
    setup,
    creds,
    bindings,
    vault,
    progress,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function input(over: Record<string, unknown> = {}) {
  return {
    storage: { s3Bucket: "my-bucket", s3Region: "auto" },
    secrets: {
      kopiaPassword: PASSWORD,
      s3AccessKeyId: "AKIA-test",
      s3SecretAccessKey: "s3-secret-test",
    },
    deviceName: "Bea's laptop",
    ...over,
  } as Parameters<DeviceSetup["run"]>[0];
}

function stage(result: { stages: readonly SetupStageState[] }, id: string): SetupStageState {
  const s = result.stages.find((x) => x.id === id);
  assert.ok(s, `stage ${id} missing`);
  return s;
}

/**
 * Approve `b` from `a`, so a genuinely new device (its own vault, its own signing
 * key, an EMPTY credential store) can also publish.
 */
async function approve(a: Device, b: Device): Promise<void> {
  const ka = await a.svc.vaultAdapter.getOrCreateSigningKey();
  const kb = await b.svc.vaultAdapter.getOrCreateSigningKey();
  await a.svc.syncBridge?.approveDevice([
    { deviceId: ka.deviceId, publicKeyHex: ka.publicKeyHex, role: "trusted" },
    { deviceId: kb.deviceId, publicKeyHex: kb.publicKeyHex, role: "trusted" },
  ] as TrustEntry[]);
}

/** Seed a fully-populated "old machine" so there is something to restore. */
async function seedSource(store: InMemoryConditionalObjectStore): Promise<{
  a: Device;
  workspace: string;
}> {
  const a = await device(store);
  const bridge = a.svc.syncBridge;
  assert.ok(bridge);
  await bridge.ensureTrustRegistry();

  assert.ok((await a.ctl.createProject({ id: "alpha", enabled: true })).ok);
  assert.ok(
    (
      await a.ctl.addServer("alpha", {
        transport: "stdio",
        id: "srv",
        command: "echo",
        args: [],
        env: { TOKEN: "${UPSTREAM_TOKEN}" },
      })
    ).ok,
  );
  await a.svc.saveManagedSecret("alpha", "UPSTREAM_TOKEN", SECRET_VALUE);
  await a.creds.enable(PASSPHRASE);

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gw-setup-ws-")));
  await a.svc.setDirectoryAgents("alpha", workspace, ["cursor"]);
  await a.bindings.push();

  return { a, workspace };
}

// ── the whole flow ──────────────────────────────────────────────────────────

test("a blank device is set up from the bucket in one pass", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  // A genuinely new machine: its own vault, so its own signing key and an EMPTY
  // credential store. Pre-approved so publishing is also available. Sharing device
  // A's vault instead would make every credential assertion below vacuous, since
  // the signing key and the server secrets live in the same vault.
  const b = await device(store, new MemoryVault());
  await approve(a, b);
  try {
    const res = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.ok(res.ok, JSON.stringify(res.stages, null, 2));
    assert.equal(res.canPublish, true);
    assert.equal(res.awaitingApproval, false);
    assert.equal(res.deviceId, b.svc.syncBridge?.selfDeviceId);

    // Projects came back.
    assert.deepEqual(
      b.svc.allConfigs().map((c) => c.id),
      ["alpha"],
    );
    // Credentials came back, so the server is no longer blocked on its reference.
    assert.equal(
      await b.svc.vaultAdapter.getManagedSecret("alpha", "UPSTREAM_TOKEN"),
      SECRET_VALUE,
    );
    const server = b.svc.runtime.status().find((s) => s.projectId === "alpha");
    assert.notEqual(server?.phase, "env-error");
    // And the browser-profile library was asked for, last.
    assert.equal(b.cloud.calls.at(-1), "syncAll");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("stages run in the documented order and each is reported once", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    const res = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.deepEqual(
      res.stages.map((s) => s.id),
      [...SETUP_STAGES],
    );
    // Order is load-bearing: credentials must land after projects (they are keyed
    // by project id) and profiles last (heaviest, nothing depends on it).
    const running = b.progress.filter((s) => s.status === "running").map((s) => s.id);
    assert.deepEqual(running, [...SETUP_STAGES]);
    // Every stage reported running then exactly one terminal state.
    for (const id of SETUP_STAGES) {
      const events = b.progress.filter((s) => s.id === id);
      assert.equal(events.length, 2, `stage ${id} reported ${events.length} events`);
      assert.equal(events[0]?.status, "running");
      assert.ok(["done", "skipped", "failed"].includes(events[1]?.status ?? ""));
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("secrets are saved before the store is probed, and the probe defers the profile bootstrap", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    await b.setup.run(input());
    const order = b.cloud.calls;
    // A probe before the credentials exist could only ever fail.
    assert.ok(
      order.indexOf("saveSecret:s3AccessKeyId") < order.findIndex((c) => c.startsWith("probe:")),
    );
    assert.ok(order.indexOf("updateConfig") < order.findIndex((c) => c.startsWith("probe:")));
    // The probe must not kick off its own background bootstrap: the profiles
    // stage runs that deliberately, where its progress is reported.
    assert.ok(order.includes("probe:scheduleBootstrap=false"));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("it is idempotent: a second pass changes nothing and still reports success", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, new MemoryVault());
  await approve(a, b);
  try {
    const first = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.ok(first.ok);
    const second = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.ok(second.ok, JSON.stringify(second.stages, null, 2));
    assert.deepEqual(
      b.svc.allConfigs().map((c) => c.id),
      ["alpha"],
    );
    assert.equal(
      await b.svc.vaultAdapter.getManagedSecret("alpha", "UPSTREAM_TOKEN"),
      SECRET_VALUE,
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── fatal stages stop the run ───────────────────────────────────────────────

test("an unreachable bucket fails storage and leaves every later stage pending", async () => {
  const store = new InMemoryConditionalObjectStore();
  const b = await device(store);
  try {
    b.cloud.probe = {
      healthy: false,
      capability: { ok: false, failedCheck: "unconfigured", message: "Bucket not configured" },
      conditionalWritesSupported: false,
    };
    const res = await b.setup.run(input());
    assert.equal(res.ok, false);
    assert.equal(stage(res, "storage").status, "failed");
    assert.equal(stage(res, "storage").detail, "Bucket not configured");
    // Reporting the same root cause seven times would be noise; "pending" is the
    // truthful description of a stage that never ran.
    for (const id of ["trust", "settings", "projects", "bindings", "credentials", "profiles"]) {
      assert.equal(stage(res, id).status, "pending", `${id} should not have run`);
    }
    assert.equal(b.cloud.calls.includes("syncAll"), false);
  } finally {
    b.cleanup();
  }
});

test("storage that cannot do conditional writes is refused with the failed check named", async () => {
  const store = new InMemoryConditionalObjectStore();
  const b = await device(store);
  try {
    b.cloud.probe = {
      healthy: true,
      capability: { ok: false, failedCheck: "cas", message: null },
      conditionalWritesSupported: false,
    };
    const res = await b.setup.run(input());
    assert.equal(res.ok, false);
    assert.match(stage(res, "storage").detail ?? "", /conditional writes/i);
    assert.match(stage(res, "storage").detail ?? "", /cas/);
  } finally {
    b.cleanup();
  }
});

test("a wrong encryption password fails at trust rather than corrupting anything", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  // Same bucket, same identity, WRONG repository password.
  const b = await device(store, a.vault, { password: "not the right password" });
  try {
    const res = await b.setup.run(input());
    // Trust itself is only signature-checked, so it adopts; the damage would show
    // up later as undecryptable projects. Either way the run must not claim
    // success with nothing restored.
    if (stage(res, "trust").status === "failed") {
      assert.equal(res.ok, false);
    } else {
      assert.equal(b.svc.allConfigs().length, 0);
      assert.ok(res.stages.some((s) => s.status === "failed" || s.status === "skipped"));
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── the approval subtlety ───────────────────────────────────────────────────

test("an unapproved device still restores, announces itself, and says it cannot publish", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  // A genuinely NEW device: its own vault, so its own signing identity, which the
  // registry has never seen.
  const b = await device(store, new MemoryVault());
  try {
    const res = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.equal(res.awaitingApproval, true);
    assert.equal(res.canPublish, false);
    assert.match(stage(res, "trust").detail ?? "", /cannot publish until an administrator/i);

    // Reading works: adopting the registry lets it verify the other device's
    // signatures, which is the whole reason setup does not block on a human.
    assert.deepEqual(
      b.svc.allConfigs().map((c) => c.id),
      ["alpha"],
    );
    assert.equal(
      await b.svc.vaultAdapter.getManagedSecret("alpha", "UPSTREAM_TOKEN"),
      SECRET_VALUE,
    );

    // And it is now discoverable for approval.
    const pending = await a.svc.syncBridge?.listPendingDevices();
    assert.ok(
      pending?.some((p) => p.deviceId === b.svc.syncBridge?.selfDeviceId),
      "the new device should be announced so an admin can approve it",
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("after approval a re-run reports that publishing is now allowed", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, new MemoryVault());
  try {
    const before = await b.setup.run(input());
    assert.equal(before.canPublish, false);

    await approve(a, b);

    const after = await b.setup.run(input());
    assert.equal(after.canPublish, true);
    assert.equal(after.awaitingApproval, false);
    assert.match(stage(after, "trust").detail ?? "", /this device is trusted/i);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a revoked device is told so instead of quietly restoring", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, new MemoryVault());
  try {
    const ka = await a.svc.vaultAdapter.getOrCreateSigningKey();
    const kb = await b.svc.vaultAdapter.getOrCreateSigningKey();
    await a.svc.syncBridge?.approveDevice([
      { deviceId: ka.deviceId, publicKeyHex: ka.publicKeyHex, role: "trusted" },
      { deviceId: kb.deviceId, publicKeyHex: kb.publicKeyHex, role: "revoked" },
    ] as TrustEntry[]);

    const res = await b.setup.run(input());
    assert.equal(res.ok, false);
    assert.equal(stage(res, "trust").status, "failed");
    assert.match(stage(res, "trust").detail ?? "", /revoked/i);
    assert.equal(stage(res, "projects").status, "pending");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── partial recovery is still recovery ──────────────────────────────────────

test("no credential passphrase skips that stage without failing the run", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  // Must be a new vault: on a reinstall that kept the OS keychain the secrets were
  // never lost, so the consequence of skipping this stage would be invisible.
  const b = await device(store, new MemoryVault());
  await approve(a, b);
  try {
    const res = await b.setup.run(input());
    assert.ok(res.ok);
    assert.equal(stage(res, "credentials").status, "skipped");
    assert.match(stage(res, "credentials").detail ?? "", /No credential passphrase/i);
    // Honest consequence: the server stays inactive, waiting for its secret.
    assert.equal(await b.svc.vaultAdapter.getManagedSecret("alpha", "UPSTREAM_TOKEN"), null);
    const server = b.svc.runtime.status().find((s) => s.projectId === "alpha");
    assert.equal(server?.phase, "env-error");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a wrong credential passphrase fails that stage but the rest still completes", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, new MemoryVault());
  await approve(a, b);
  try {
    const res = await b.setup.run(input({ credentialPassphrase: "the wrong passphrase" }));
    assert.equal(res.ok, false);
    assert.equal(stage(res, "credentials").status, "failed");
    assert.match(stage(res, "credentials").detail ?? "", /does not open the stored backup/i);
    // A device with its projects and folders back is far more useful than one
    // that aborted, so the remaining stages must still have run.
    assert.equal(stage(res, "projects").status, "done");
    assert.equal(stage(res, "profiles").status, "done");
    assert.deepEqual(
      b.svc.allConfigs().map((c) => c.id),
      ["alpha"],
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a failing profile library is reported without losing the rest", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    b.cloud.syncAllThrows = new Error("Kopia repository is unreachable");
    const res = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.equal(res.ok, false);
    assert.equal(stage(res, "profiles").status, "failed");
    assert.equal(stage(res, "profiles").detail, "Kopia repository is unreachable");
    assert.equal(stage(res, "projects").status, "done");
    assert.equal(stage(res, "credentials").status, "done");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("an empty bucket reports skipped stages, not failures", async () => {
  const store = new InMemoryConditionalObjectStore();
  const b = await device(store);
  try {
    b.cloud.bootstrap = { ...b.cloud.bootstrap, remoteDiscovered: 0, restored: 0 };
    const res = await b.setup.run(input());
    assert.ok(res.ok, JSON.stringify(res.stages, null, 2));
    // First device on a fresh bucket: it bootstraps itself as the trust root.
    assert.equal(stage(res, "trust").status, "done");
    assert.equal(res.canPublish, true);
    assert.equal(stage(res, "settings").status, "skipped");
    assert.equal(stage(res, "projects").status, "skipped");
    assert.equal(stage(res, "bindings").status, "skipped");
    assert.equal(stage(res, "credentials").status, "skipped");
    assert.equal(stage(res, "profiles").status, "skipped");
  } finally {
    b.cleanup();
  }
});

test("a folder that no longer exists is skipped and named, not fatal", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a, workspace } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    // The old machine's folder is gone on the replacement.
    rmSync(workspace, { recursive: true, force: true });
    const res = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.ok(res.ok, JSON.stringify(res.stages, null, 2));
    assert.equal(stage(res, "bindings").status, "done");
    assert.match(stage(res, "bindings").detail ?? "", /skipped/i);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("bindings are relinked when the folder is still there", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a, workspace } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    mkdirSync(workspace, { recursive: true });
    const res = await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.equal(stage(res, "bindings").status, "done");
    assert.match(stage(res, "bindings").detail ?? "", /1 folder relinked/i);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── the flow must not leak ──────────────────────────────────────────────────

test("no supplied secret appears in any stage detail", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    // Force failures on both fatal and non-fatal paths so error text is included.
    b.cloud.syncAllThrows = new Error("boom");
    const res = await b.setup.run(
      input({ credentialPassphrase: "the wrong passphrase but long enough" }),
    );
    const text = JSON.stringify([res.stages, b.progress]);
    for (const leak of [
      PASSWORD,
      PASSPHRASE,
      "AKIA-test",
      "s3-secret-test",
      "the wrong passphrase but long enough",
      SECRET_VALUE,
    ]) {
      assert.ok(!text.includes(leak), `stage details leaked ${leak}`);
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a throwing progress listener does not break the run", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, a.vault);
  try {
    const setup = new DeviceSetup({
      cloud: b.cloud,
      service: b.svc,
      settings: new SettingsSync({
        service: b.svc,
        getSettings: () => settings(),
        applyPatch: async () => settings(),
      }),
      bindings: b.bindings,
      credentials: b.creds,
      onStage: () => {
        throw new Error("a UI listener blew up");
      },
    });
    const res = await setup.run(input({ credentialPassphrase: PASSPHRASE }));
    assert.ok(res.ok, JSON.stringify(res.stages, null, 2));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("credentials restored by setup are exactly the project secrets, never the bucket keys", async () => {
  const store = new InMemoryConditionalObjectStore();
  const { a } = await seedSource(store);
  const b = await device(store, new MemoryVault());
  await approve(a, b);
  try {
    await b.setup.run(input({ credentialPassphrase: PASSPHRASE }));
    // The flow hands the bucket credentials to Cloud Sync's vault refs, and the
    // bundle carries only project material — the two must not have crossed.
    const names = await b.vault.names();
    assert.ok(names.includes(projectSecretName("alpha", "UPSTREAM_TOKEN")));
    const bundleable = await b.svc.vaultAdapter.bundleableNames({ excludedNames: EXCLUDED });
    assert.deepEqual(bundleable, [projectSecretName("alpha", "UPSTREAM_TOKEN")]);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
