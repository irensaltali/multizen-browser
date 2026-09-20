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

test("normalizeSync preserves an existing device id + merges partial config", () => {
  const out = normalizeSync({ deviceId: "device_keepme", workerUrl: "https://x" });
  assert.equal(out.deviceId, "device_keepme");
  assert.equal(out.workerUrl, "https://x");
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

test("SettingsStore.update deep-merges sync partial + keeps device id, no secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const store = new SettingsStore(join(dir, "settings.json"));
  const initial = await store.load();
  const deviceId = initial.sync.deviceId;
  const next = await store.update({ sync: { workerUrl: "https://sync.test" } as never });
  assert.equal(next.sync.workerUrl, "https://sync.test");
  assert.equal(next.sync.deviceId, deviceId, "device identity preserved across update");
  assert.equal(next.sync.s3Region, "auto", "other sync fields preserved");
});
