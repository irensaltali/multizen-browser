import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertNoDeviceLocalSettings,
  DEVICE_LOCAL_SETTINGS_KEYS,
  parseSharedSettings,
  SHARED_SETTINGS_KEYS,
  sharedSettingsEqual,
  sharedSettingsPatch,
  toSharedSettings,
} from "./shared.js";
import { SYNC_DEFAULTS, type AppSettings } from "./index.js";

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
      deviceDisplayName: "Alice's MacBook",
      s3Bucket: "my-bucket",
      kopiaPasswordRef: "kopia-password",
      s3AccessKeyIdRef: "s3-access-key",
      s3SecretAccessKeyRef: "s3-secret-key",
    },
    ...over,
  };
}

test("only the shared subset is projected for publishing", () => {
  const shared = toSharedSettings(settings());
  assert.deepEqual(Object.keys(shared).sort(), [...SHARED_SETTINGS_KEYS].sort());
  assert.deepEqual(shared, {
    theme: "dark",
    mcpHttpEnabled: true,
    autoUpdate: true,
    engineAutoUpdate: false,
  });
});

test("device identity, bucket coordinates and credential refs never get projected", () => {
  const serialized = JSON.stringify(toSharedSettings(settings()));
  // Identity must stay unique per device or trust and leasing both break.
  assert.ok(!serialized.includes("device_local"));
  assert.ok(!serialized.includes("Alice's MacBook"));
  // Bucket access cannot travel inside the bucket.
  assert.ok(!serialized.includes("my-bucket"));
  assert.ok(!serialized.includes("kopia-password"));
  assert.ok(!serialized.includes("s3-access-key"));
  assert.ok(!serialized.includes("s3-secret-key"));
  // The local listener port and the engine choice are machine decisions.
  assert.ok(!serialized.includes("7777"));
  assert.ok(!serialized.includes("cloakbrowser"));
});

test("the shared and device-local key lists are disjoint", () => {
  for (const key of DEVICE_LOCAL_SETTINGS_KEYS) {
    assert.ok(
      !(SHARED_SETTINGS_KEYS as readonly string[]).includes(key),
      `${key} must not be shared`,
    );
  }
});

test("assertNoDeviceLocalSettings catches a leak before it is published", () => {
  assert.doesNotThrow(() => assertNoDeviceLocalSettings(toSharedSettings(settings())));
  for (const key of DEVICE_LOCAL_SETTINGS_KEYS) {
    assert.throws(
      () => assertNoDeviceLocalSettings({ theme: "dark", [key]: "leaked" }),
      new RegExp(`device-local key "${key}"`),
    );
  }
});

test("a remote document is validated field by field", () => {
  assert.deepEqual(
    parseSharedSettings({
      theme: "dark",
      mcpHttpEnabled: false,
      autoUpdate: true,
      engineAutoUpdate: true,
    }),
    { theme: "dark", mcpHttpEnabled: false, autoUpdate: true, engineAutoUpdate: true },
  );
  // Wrong types are dropped, not coerced.
  assert.deepEqual(
    parseSharedSettings({ theme: "light", mcpHttpEnabled: "yes", autoUpdate: 1 }),
    {},
  );
  // Unknown keys are ignored entirely.
  assert.deepEqual(parseSharedSettings({ somethingNew: true }), {});
  for (const bad of [null, undefined, 42, "x", []]) {
    assert.deepEqual(parseSharedSettings(bad), {});
  }
});

test("a device-local key smuggled into a remote document is ignored", () => {
  const parsed = parseSharedSettings({
    theme: "dark",
    browserEngine: "cft",
    mcpHttpPort: 9999,
    sync: { s3Bucket: "attacker-bucket" },
  });
  assert.deepEqual(parsed, { theme: "dark" });
});

test("a patch contains only the keys that actually changed", () => {
  const current = settings({ mcpHttpEnabled: true, autoUpdate: true });
  assert.deepEqual(
    sharedSettingsPatch(current, { mcpHttpEnabled: true, autoUpdate: true }),
    {},
    "an identical document produces no write",
  );
  assert.deepEqual(
    sharedSettingsPatch(current, { mcpHttpEnabled: false, autoUpdate: true }),
    { mcpHttpEnabled: false },
  );
});

test("a partial document from an older device does not blank unknown settings", () => {
  // An older peer publishes only the fields it knows about. The absent ones must
  // keep their local values rather than being reset.
  const current = settings({ engineAutoUpdate: true });
  const patch = sharedSettingsPatch(current, parseSharedSettings({ theme: "dark" }));
  assert.deepEqual(patch, {}, "nothing changes, and engineAutoUpdate survives");
});

test("sharedSettingsEqual compares exactly the shared keys", () => {
  const a = toSharedSettings(settings());
  assert.ok(sharedSettingsEqual(a, { ...a }));
  assert.ok(!sharedSettingsEqual(a, { ...a, autoUpdate: !a.autoUpdate }));
  // A difference in a device-local field is irrelevant to shared equality.
  const differentEngine = toSharedSettings(settings({ browserEngine: "cft" }));
  assert.ok(sharedSettingsEqual(a, differentEngine));
});
