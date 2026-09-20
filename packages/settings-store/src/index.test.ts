import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, normalizeSync, SYNC_DEFAULTS } from "./index.ts";

test("normalizeSync mints a stable device identity on first run", () => {
  const a = normalizeSync(undefined);
  assert.match(a.deviceId, /^device_[0-9a-f]+$/);
  assert.equal(a.enabled, false);
  assert.equal(a.s3Region, "auto");
  assert.equal(a.kopiaPasswordRef, SYNC_DEFAULTS.kopiaPasswordRef);
});

test("normalizeSync applies coordinator defaults (control prefix, path-style, timings)", () => {
  const a = normalizeSync(undefined);
  assert.equal(a.controlPrefix, "multizen-control");
  assert.equal(a.s3ForcePathStyle, false);
  assert.equal(a.leaseTtlMs, 60_000);
  assert.equal(a.renewalMs, 15_000);
  assert.equal(a.clockSkewSafetyMs, 10_000);
});

test("normalizeSync accepts valid coordinator overrides", () => {
  const a = normalizeSync({
    deviceId: "device_x",
    controlPrefix: "ctl",
    s3ForcePathStyle: true,
    leaseTtlMs: 90_000,
    renewalMs: 20_000,
    clockSkewSafetyMs: 5_000,
  });
  assert.equal(a.controlPrefix, "ctl");
  assert.equal(a.s3ForcePathStyle, true);
  assert.equal(a.leaseTtlMs, 90_000);
  assert.equal(a.renewalMs, 20_000);
  assert.equal(a.clockSkewSafetyMs, 5_000);
});

test("normalizeSync rejects a blank control prefix (falls back to default)", () => {
  const a = normalizeSync({ deviceId: "device_x", controlPrefix: "   " });
  assert.equal(a.controlPrefix, "multizen-control");
});

test("normalizeSync ignores invalid timing values (keeps defaults)", () => {
  const a = normalizeSync({
    deviceId: "device_x",
    leaseTtlMs: -1,
    renewalMs: 0,
    clockSkewSafetyMs: 1.5,
  } as never);
  assert.equal(a.leaseTtlMs, 60_000);
  assert.equal(a.renewalMs, 15_000);
  assert.equal(a.clockSkewSafetyMs, 10_000);
});

test("normalizeSync preserves an existing device id + merges partial config", () => {
  const out = normalizeSync({ deviceId: "device_keepme", s3Bucket: "b" });
  assert.equal(out.deviceId, "device_keepme");
  assert.equal(out.s3Bucket, "b");
});

test("normalizeSync DROPS legacy Worker/Access fields", () => {
  const out = normalizeSync({
    deviceId: "device_x",
    workerUrl: "https://legacy.example.com",
    accessClientId: "legacy.access",
    accessClientSecretRef: "accessClientSecret",
  } as never);
  const rec = out as unknown as Record<string, unknown>;
  assert.equal(rec.workerUrl, undefined, "workerUrl dropped");
  assert.equal(rec.accessClientId, undefined, "accessClientId dropped");
  assert.equal(rec.accessClientSecretRef, undefined, "accessClientSecretRef dropped");
});

test("normalizeSync never carries secrets — only ref names + non-secret fields", () => {
  // Even if a malformed blob smuggles a secret-looking key, it's ignored.
  const out = normalizeSync({ deviceId: "device_x", kopiaPassword: "SECRET" } as never);
  assert.equal((out as unknown as Record<string, unknown>).kopiaPassword, undefined);
});

test("SettingsStore.load backfills sync on a legacy settings.json (backwards-compatible)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const file = join(dir, "settings.json");
  // Legacy file with NO sync key at all.
  writeFileSync(file, JSON.stringify({ theme: "dark", mcpHttpEnabled: true, mcpHttpPort: 7777 }));
  const store = new SettingsStore(file);
  const s = await store.load();
  assert.equal(s.mcpHttpPort, 7777);
  assert.ok(s.sync);
  assert.match(s.sync.deviceId, /^device_/);
  // Identity was persisted back to disk.
  const persisted = JSON.parse(readFileSync(file, "utf8")) as { sync?: { deviceId?: string } };
  assert.equal(persisted.sync?.deviceId, s.sync.deviceId);
});

test("SettingsStore.load drops legacy Worker/Access fields and does not write them back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const file = join(dir, "settings.json");
  // Legacy sync blob carrying Worker/Access fields.
  writeFileSync(
    file,
    JSON.stringify({
      theme: "dark",
      mcpHttpEnabled: true,
      mcpHttpPort: 7777,
      sync: {
        deviceId: "device_legacy",
        enabled: true,
        workerUrl: "https://legacy.example.com",
        accessClientId: "legacy.access",
        accessClientSecretRef: "accessClientSecret",
        s3Bucket: "bucket",
      },
    }),
  );
  const store = new SettingsStore(file);
  const s = await store.load();
  const rec = s.sync as unknown as Record<string, unknown>;
  assert.equal(rec.workerUrl, undefined);
  assert.equal(rec.accessClientId, undefined);
  assert.equal(rec.accessClientSecretRef, undefined);
  assert.equal(s.sync.s3Bucket, "bucket", "non-secret field preserved");
  assert.equal(s.sync.controlPrefix, "multizen-control", "control prefix defaulted");
  // Force a persist via update, then re-read the raw file: legacy keys gone.
  await store.update({ sync: { s3Region: "auto" } as never });
  const persisted = JSON.parse(readFileSync(file, "utf8")) as { sync?: Record<string, unknown> };
  assert.equal(persisted.sync?.workerUrl, undefined, "workerUrl not written back");
  assert.equal(persisted.sync?.accessClientId, undefined, "accessClientId not written back");
  assert.equal(persisted.sync?.accessClientSecretRef, undefined, "secret ref not written back");
});

test("SettingsStore.update deep-merges sync partial + keeps device id, no secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const store = new SettingsStore(join(dir, "settings.json"));
  const initial = await store.load();
  const deviceId = initial.sync.deviceId;
  const next = await store.update({ sync: { s3Bucket: "my-bucket" } as never });
  assert.equal(next.sync.s3Bucket, "my-bucket");
  assert.equal(next.sync.deviceId, deviceId, "device identity preserved across update");
  assert.equal(next.sync.s3Region, "auto", "other sync fields preserved");
  assert.equal(next.sync.controlPrefix, "multizen-control");
});
