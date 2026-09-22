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

test("SettingsStore persists sync.enabled across false→true→false reloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const file = join(dir, "settings.json");

  // Fresh store: sync starts disabled by default.
  const store1 = new SettingsStore(file);
  const s1 = await store1.load();
  assert.equal(s1.sync.enabled, false, "sync disabled by default");
  const deviceId = s1.sync.deviceId;

  // Enable → persist → reload in a NEW store instance (fresh cache).
  await store1.update({ sync: { enabled: true } as never });
  const store2 = new SettingsStore(file);
  const s2 = await store2.load();
  assert.equal(s2.sync.enabled, true, "enabled persisted across reload");
  assert.equal(s2.sync.deviceId, deviceId, "device identity stable across reload");

  // Confirm the raw file reflects enabled:true.
  const raw2 = JSON.parse(readFileSync(file, "utf8")) as { sync?: { enabled?: boolean } };
  assert.equal(raw2.sync?.enabled, true);

  // Disable → persist → reload again.
  await store2.update({ sync: { enabled: false } as never });
  const store3 = new SettingsStore(file);
  const s3 = await store3.load();
  assert.equal(s3.sync.enabled, false, "disabled persisted across reload");
  const raw3 = JSON.parse(readFileSync(file, "utf8")) as { sync?: { enabled?: boolean } };
  assert.equal(raw3.sync?.enabled, false);
  assert.equal(s3.sync.deviceId, deviceId, "device identity still stable");
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

test("SettingsStore.load DROPS a legacy usageReporting key and keeps all other settings/sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const file = join(dir, "settings.json");
  // Legacy file carrying the removed anonymous-usage heartbeat flag alongside
  // a fully-populated sync blob.
  writeFileSync(
    file,
    JSON.stringify({
      theme: "dark",
      mcpHttpEnabled: true,
      mcpHttpPort: 7777,
      browserEngine: "cloakbrowser",
      autoUpdate: true,
      engineAutoUpdate: true,
      usageReporting: true,
      sync: {
        deviceId: "device_legacy",
        enabled: true,
        s3Bucket: "bucket",
        s3Region: "auto",
      },
    }),
  );
  const store = new SettingsStore(file);
  const s = await store.load();
  const rec = s as unknown as Record<string, unknown>;
  // Legacy key gone from the in-memory normalized object.
  assert.equal(rec.usageReporting, undefined, "usageReporting dropped in memory");
  // All other settings preserved.
  assert.equal(s.mcpHttpPort, 7777);
  assert.equal(s.browserEngine, "cloakbrowser");
  assert.equal(s.autoUpdate, true);
  assert.equal(s.engineAutoUpdate, true);
  // Sync fields preserved.
  assert.equal(s.sync.deviceId, "device_legacy");
  assert.equal(s.sync.enabled, true);
  assert.equal(s.sync.s3Bucket, "bucket");
  assert.equal(s.sync.controlPrefix, "multizen-control");
  // The scrubbed file was written back on load — usageReporting not persisted.
  const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.usageReporting, undefined, "usageReporting not written back on load");
  assert.equal((persisted.sync as { deviceId?: string }).deviceId, "device_legacy");
});

test("SettingsStore.update never writes back a legacy usageReporting key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(
    file,
    JSON.stringify({
      theme: "dark",
      mcpHttpEnabled: true,
      mcpHttpPort: 7777,
      usageReporting: false,
      sync: { deviceId: "device_x", s3Bucket: "b" },
    }),
  );
  const store = new SettingsStore(file);
  await store.load();
  // Even if a stale caller smuggles usageReporting through update, it's dropped.
  const next = await store.update({ usageReporting: true } as never);
  assert.equal((next as unknown as Record<string, unknown>).usageReporting, undefined);
  const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.usageReporting, undefined, "usageReporting not persisted via update");
  assert.equal((persisted.sync as { s3Bucket?: string }).s3Bucket, "b", "sync field preserved");
});
