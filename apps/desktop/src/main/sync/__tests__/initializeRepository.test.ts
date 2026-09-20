/**
 * Focused tests for the first-run "Initialize Kopia Repository" operation.
 *
 * Covered contract:
 *   - success calls KopiaAdapter.createRepository EXACTLY once, connects
 *     implicitly nowhere (create only), and emits `initializing` → `done`
 *     progress with a completion status result;
 *   - missing credentials (no Kopia password) fail BEFORE createRepository is
 *     ever invoked (deterministic InvalidInput, no process spawned);
 *   - an unset S3 bucket fails up-front with a deterministic InvalidInput and
 *     never touches Kopia;
 *   - emitted progress + returned result never contain a secret value.
 *
 * These exercise the same controller path the `sync:initializeRepository` IPC
 * handler drives (the handler is a thin `wrap()` around this method).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncErrorCode, isSyncError } from "@multizen/sync-core";
import { SyncController } from "../SyncController.ts";
import { FakeCredentialVault } from "../CredentialVault.ts";
import type { SyncProgressEvent } from "../types.ts";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeProfileManager {
  profiles = new Map<string, { id: string; name: string; dataDir: string }>();
  states = new Map<string, Record<string, unknown>>();
  get(id: string) {
    return this.profiles.get(id) ?? null;
  }
  getSyncState(id: string) {
    return this.states.get(id) ?? null;
  }
}

class FakeDriver {
  isRunning() {
    return false;
  }
  async countProcessesUsingDataDir() {
    return 0;
  }
  async close() {
    /* no-op */
  }
}

class FakeKopia {
  createRepositoryCalls = 0;
  connectCalls = 0;
  lastCreateTarget: unknown = null;
  async connect() {
    this.connectCalls += 1;
  }
  async createRepository(target: unknown) {
    this.createRepositoryCalls += 1;
    this.lastCreateTarget = target;
  }
  async snapshot() {
    return { id: "snapX" };
  }
  async restore() {
    /* no-op */
  }
}

const SECRET_PW = "CANARY-KOPIA-PW-init-DO-NOT-LEAK";
const SECRET_AK = "CANARY-AKIA-init-DO-NOT-LEAK";
const SECRET_SK = "CANARY-S3-SECRET-init-DO-NOT-LEAK";

function makeSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sync: {
      enabled: true,
      workerUrl: "https://sync.example.com",
      accessClientId: "cid.access",
      s3Endpoint: "endpoint.example.com",
      s3Region: "auto",
      s3Bucket: "bucket",
      s3Prefix: "profiles/",
      deviceId: "device_test",
      deviceDisplayName: "Test Mac",
      kopiaPasswordRef: "kopiaPassword",
      s3AccessKeyIdRef: "s3AccessKeyId",
      s3SecretAccessKeyRef: "s3SecretAccessKey",
      accessClientSecretRef: "accessClientSecret",
      kopiaConfigPath: "",
      kopiaBinPath: "",
      ...overrides,
    },
  };
}

class FakeSettingsStore {
  constructor(private settings: ReturnType<typeof makeSettings>) {}
  async update(patch: { sync?: Record<string, unknown> }) {
    if (patch.sync) Object.assign(this.settings.sync, patch.sync);
    return this.settings;
  }
}

class FakeClient {
  updateConfig() {}
  async health() {
    return true;
  }
}

function makeController(opts: {
  kopia?: FakeKopia;
  vault?: FakeCredentialVault;
  settings?: ReturnType<typeof makeSettings>;
  events?: SyncProgressEvent[];
}) {
  const settings = opts.settings ?? makeSettings();
  const vault = opts.vault ?? new FakeCredentialVault();
  const root = mkdtempSync(join(tmpdir(), "mz-init-"));
  const kopia = opts.kopia ?? new FakeKopia();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: new FakeSettingsStore(settings),
    getSettings: () => settings,
    profileManager: new FakeProfileManager(),
    vault,
    driver: new FakeDriver(),
    profilesRoot: root,
    kopiaConfigDefault: join(root, "kopia.config"),
    client: new FakeClient(),
    makeKopia: () => kopia,
    sameVolume: () => true,
    emit: (e: SyncProgressEvent) => opts.events?.push(e),
  };
  return { ctl: new SyncController(deps), kopia };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("initializeRepository calls createRepository exactly once and emits status", async () => {
  const vault = new FakeCredentialVault();
  await vault.set("kopiaPassword", SECRET_PW);
  await vault.set("s3AccessKeyId", SECRET_AK);
  await vault.set("s3SecretAccessKey", SECRET_SK);
  const events: SyncProgressEvent[] = [];
  const { ctl, kopia } = makeController({ vault, events });

  const result = await ctl.initializeRepository();

  assert.equal(kopia.createRepositoryCalls, 1, "createRepository called exactly once");
  assert.equal(kopia.connectCalls, 0, "init must not connect (connect stays implicit)");
  assert.equal(result.created, true);
  assert.equal(result.target.bucket, "bucket");
  assert.equal(result.target.prefix, "profiles/");

  // Progress: initializing → done, and a completion status event is emitted.
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes("initializing"), "emits initializing");
  assert.equal(phases.at(-1), "done", "final status is done");
  await ctl.shutdown();
});

test("initializeRepository fails BEFORE createRepository when Kopia password is missing", async () => {
  const vault = new FakeCredentialVault();
  // Intentionally no kopiaPassword set.
  await vault.set("s3AccessKeyId", SECRET_AK);
  const events: SyncProgressEvent[] = [];
  const { ctl, kopia } = makeController({ vault, events });

  await assert.rejects(
    () => ctl.initializeRepository(),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput,
  );
  assert.equal(kopia.createRepositoryCalls, 0, "must NOT invoke createRepository without creds");
  await ctl.shutdown();
});

test("initializeRepository fails deterministically when bucket is unset (no Kopia touched)", async () => {
  const vault = new FakeCredentialVault();
  await vault.set("kopiaPassword", SECRET_PW);
  const events: SyncProgressEvent[] = [];
  const { ctl, kopia } = makeController({
    vault,
    events,
    settings: makeSettings({ s3Bucket: "  " }),
  });

  await assert.rejects(
    () => ctl.initializeRepository(),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput,
  );
  assert.equal(kopia.createRepositoryCalls, 0, "must NOT invoke createRepository with no bucket");
  await ctl.shutdown();
});

test("initializeRepository never leaks secrets in progress events or result", async () => {
  const vault = new FakeCredentialVault();
  await vault.set("kopiaPassword", SECRET_PW);
  await vault.set("s3AccessKeyId", SECRET_AK);
  await vault.set("s3SecretAccessKey", SECRET_SK);
  const events: SyncProgressEvent[] = [];
  const { ctl } = makeController({ vault, events });

  const result = await ctl.initializeRepository();
  const haystack = JSON.stringify(result) + JSON.stringify(events);
  for (const secret of [SECRET_PW, SECRET_AK, SECRET_SK]) {
    assert.equal(haystack.includes(secret), false, `secret must not leak: ${secret}`);
  }
  await ctl.shutdown();
});
