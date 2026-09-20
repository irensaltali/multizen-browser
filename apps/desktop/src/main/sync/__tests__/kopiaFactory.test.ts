import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKopiaBinary, KOPIA_PINNED_VERSION } from "../kopiaFactory.ts";

test("pins the Kopia version to 0.23.1 (must match scripts/kopia/kopiaAssets.mjs)", () => {
  assert.equal(KOPIA_PINNED_VERSION, "0.23.1");
});

test("override path wins when it exists", () => {
  const bin = resolveKopiaBinary({
    overridePath: "/opt/kopia",
    env: {},
    exists: (p) => p === "/opt/kopia",
  });
  assert.equal(bin, "/opt/kopia");
});

test("MULTIZEN_KOPIA_BIN dev override is used when override absent", () => {
  const bin = resolveKopiaBinary({
    overridePath: "",
    env: { MULTIZEN_KOPIA_BIN: "/dev/kopia" },
    exists: (p) => p === "/dev/kopia",
  });
  assert.equal(bin, "/dev/kopia");
});

test("packaged deterministic path <resources>/kopia/kopia is preferred", () => {
  const bin = resolveKopiaBinary({
    resourcesPath: "/app/resources",
    platform: "darwin",
    env: {},
    exists: (p) => p === "/app/resources/kopia/kopia",
  });
  assert.equal(bin, "/app/resources/kopia/kopia");
});

test("legacy flat <resources>/kopia is used as a fallback", () => {
  const bin = resolveKopiaBinary({
    resourcesPath: "/app/resources",
    platform: "darwin",
    env: {},
    // Only the legacy flat path exists (older packaged build).
    exists: (p) => p === "/app/resources/kopia",
  });
  assert.equal(bin, "/app/resources/kopia");
});

test("windows uses kopia.exe in packaged subdir path", () => {
  const bin = resolveKopiaBinary({
    resourcesPath: "C:/app/resources",
    platform: "win32",
    env: {},
    exists: (p) => p === "C:/app/resources/kopia/kopia.exe",
  });
  assert.equal(bin, "C:/app/resources/kopia/kopia.exe");
});

test("falls back to bare kopia on PATH when nothing exists", () => {
  const bin = resolveKopiaBinary({ env: {}, platform: "linux", exists: () => false });
  assert.equal(bin, "kopia");
});
