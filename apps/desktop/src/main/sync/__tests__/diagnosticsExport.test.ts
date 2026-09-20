/**
 * Canary redaction tests for SyncController.exportDiagnostics.
 *
 * We plant UNIQUE, unmistakable "canary" secret values in the vault, the
 * config, and a journal message, then serialize the full diagnostics export
 * and assert NONE of the canaries appear anywhere in the JSON — while the
 * expected NON-secret fields (revisions, timestamps, kopia path, worker origin)
 * are present.
 *
 * This guards the hard contract: the export must never carry vault contents,
 * the Access client secret, the repository password, S3 secret/access keys, or
 * raw request headers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncController } from "../SyncController.ts";
import { FakeCredentialVault } from "../CredentialVault.ts";

// Distinctive canaries — if any of these strings survive into the export, the
// redaction contract is broken.
const CANARY = {
  kopiaPassword: "CANARY-KOPIA-PW-9f3a7c11-DO-NOT-LEAK",
  s3AccessKeyId: "CANARY-AKIA-ACCESSKEY-8821-DO-NOT-LEAK",
  s3SecretAccessKey: "CANARY-S3-SECRET-772af-DO-NOT-LEAK",
  accessClientSecret: "CANARY-CF-ACCESS-SECRET-4410-DO-NOT-LEAK",
};

class FakeProfileManager {
  profiles = new Map<string, { id: string; name: string; dataDir: string }>();
  states = new Map<string, Record<string, unknown>>();
  ops: Array<Record<string, unknown>> = [];
  list() {
    return [...this.profiles.values()].map((p) => ({ id: p.id }));
  }
  get(id: string) {
    return this.profiles.get(id) ?? null;
  }
  getSyncState(id: string) {
    return this.states.get(id) ?? null;
  }
  upsertSyncState(input: { profileId: string } & Record<string, unknown>) {
    const prev = this.states.get(input.profileId) ?? {};
    const row = { ...prev, ...input, updatedAt: new Date().toISOString() };
    this.states.set(input.profileId, row);
    return row;
  }
  listSyncOperations(_id: string, _limit = 50) {
    return this.ops;
  }
}

class FakeDriver {
  isRunning() {
    return false;
  }
  async countProcessesUsingDataDir() {
    return 0;
  }
  async close() {}
}

function makeSettings() {
  return {
    sync: {
      enabled: true,
      workerUrl: "https://sync.example.com/base/path?token=SHOULD-NOT-APPEAR",
      accessClientId: "cid.access",
      s3Endpoint: "endpoint",
      s3Region: "auto",
      s3Bucket: "bucket",
      s3Prefix: "",
      deviceId: "device_test",
      deviceDisplayName: "Test Mac",
      kopiaPasswordRef: "kopiaPassword",
      s3AccessKeyIdRef: "s3AccessKeyId",
      s3SecretAccessKeyRef: "s3SecretAccessKey",
      accessClientSecretRef: "accessClientSecret",
      kopiaConfigPath: "",
      kopiaBinPath: "",
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

/** Client stub that returns owner/lease state (no secrets in its surface). */
class FakeClient {
  updateConfig() {}
  async health() {
    return true;
  }
  async getState(profileId: string) {
    return {
      kind: "state" as const,
      state: {
        profileId,
        currentRevision: 7,
        latestSnapshotId: "snap-7",
        ownerDeviceId: "device_other",
        leaseExpiresAt: 1_900_000_000_000,
        fencingToken: 3,
      },
    };
  }
}

async function makeController() {
  const settings = makeSettings();
  const vault = new FakeCredentialVault();
  await vault.set("kopiaPassword", CANARY.kopiaPassword);
  await vault.set("s3AccessKeyId", CANARY.s3AccessKeyId);
  await vault.set("s3SecretAccessKey", CANARY.s3SecretAccessKey);
  await vault.set("accessClientSecret", CANARY.accessClientSecret);

  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-diag-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({
    profileId: "p",
    syncEnabled: true,
    dirty: true,
    localRevision: 5,
    baseRevision: 4,
    remoteRevision: 7,
    latestSnapshotId: "snap-5",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
  });
  // A journal op whose message accidentally embedded a secret at write time —
  // the export must re-redact it defensively.
  pm.ops = [
    {
      id: "op1",
      kind: "publish",
      status: "failed",
      fromRevision: 4,
      toRevision: null,
      snapshotId: null,
      message: `boom while using pw=${CANARY.kopiaPassword} and key=${CANARY.s3SecretAccessKey}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: new FakeSettingsStore(settings),
    getSettings: () => settings,
    profileManager: pm,
    vault,
    driver: new FakeDriver(),
    profilesRoot: dataDir,
    kopiaConfigDefault: join(dataDir, "kopia.config"),
    client: new FakeClient(),
    appVersion: "9.9.9",
    platform: "darwin",
    arch: "arm64",
    binExists: () => true,
  };
  return { ctl: new SyncController(deps), pm };
}

test("exportDiagnostics contains no secret canaries anywhere in the JSON", async () => {
  const { ctl } = await makeController();
  const bundle = await ctl.exportDiagnostics();
  const serialized = JSON.stringify(bundle);

  for (const [name, value] of Object.entries(CANARY)) {
    assert.ok(
      !serialized.includes(value),
      `secret canary ${name} leaked into diagnostics export`,
    );
  }
  // Signed-URL style token in workerUrl must not survive either (origin only).
  assert.ok(!serialized.includes("SHOULD-NOT-APPEAR"), "workerUrl query token leaked");
});

test("exportDiagnostics surfaces expected non-secret fields", async () => {
  const { ctl } = await makeController();
  const bundle = await ctl.exportDiagnostics();

  assert.equal(bundle.appVersion, "9.9.9");
  assert.equal(bundle.platform, "darwin");
  assert.equal(bundle.arch, "arm64");
  assert.equal(bundle.kopiaPinnedVersion, "0.23.1");
  assert.equal(bundle.kopiaBinPresent, true);
  // Worker ORIGIN only (no path/query).
  assert.equal(bundle.backend.workerOrigin, "https://sync.example.com");
  assert.equal(bundle.backend.accessClientIdPresent, true);
  assert.equal(bundle.backend.healthy, null);

  assert.equal(bundle.profiles.length, 1);
  const p = bundle.profiles[0]!;
  assert.equal(p.profileId, "p");
  assert.equal(p.localRevision, 5);
  assert.equal(p.baseRevision, 4);
  assert.equal(p.remoteRevision, 7);
  assert.equal(p.latestSnapshotId, "snap-5");
  assert.equal(p.lastSyncedAt, "2026-01-01T00:00:00.000Z");
  // Owner/lease came from the backend stub.
  assert.ok(p.owner);
  assert.equal(p.owner?.ownerDeviceId, "device_other");
  assert.equal(p.owner?.leaseExpiresAt, 1_900_000_000_000);
  assert.equal(p.owner?.currentRevision, 7);
  // The last operation message was re-redacted.
  assert.ok(p.lastOperation);
  assert.equal(p.lastOperation?.status, "failed");
  assert.ok(p.lastOperation?.message?.includes("[REDACTED]"));
  assert.ok(!p.lastOperation?.message?.includes(CANARY.kopiaPassword));
});

test("exportDiagnostics for a single profile limits to that profile", async () => {
  const { ctl, pm } = await makeController();
  pm.profiles.set("q", { id: "q", name: "Q", dataDir: "/tmp/q" });
  pm.upsertSyncState({ profileId: "q", syncEnabled: true });
  const bundle = await ctl.exportDiagnostics("p");
  assert.equal(bundle.profiles.length, 1);
  assert.equal(bundle.profiles[0]!.profileId, "p");
});
