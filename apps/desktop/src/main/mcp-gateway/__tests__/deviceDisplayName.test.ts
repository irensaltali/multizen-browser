import assert from "node:assert/strict";
import test from "node:test";

import {
  migrateLegacyDeviceDisplayName,
  normalizeDeviceDisplayName,
  systemDeviceDisplayName,
} from "../../deviceDisplayName.js";

test("the system device name prefers the macOS Computer Name", () => {
  assert.equal(
    systemDeviceDisplayName("  Iren’s   MacBook Pro\n", "irens-macbook-pro.local"),
    "Iren’s MacBook Pro",
  );
});

test("the system device name falls back to a cleaned hostname", () => {
  assert.equal(systemDeviceDisplayName("", "studio-mac.local"), "studio-mac");
});

test("only the legacy placeholder is migrated", () => {
  assert.equal(migrateLegacyDeviceDisplayName("Studio iMac"), "Studio iMac");
  assert.ok(migrateLegacyDeviceDisplayName("This device").length > 0);
});

test("device names are normalized and bounded", () => {
  assert.equal(normalizeDeviceDisplayName("  My   Mac  "), "My Mac");
  assert.equal(normalizeDeviceDisplayName("x".repeat(100)).length, 80);
});
