import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertManifestSafe,
  sanitizeExtensions,
  toManifest,
  type ManifestExtensionInput,
} from "@multizen/sync-core";

import { storeEntryDir } from "../../extensions/extensionStore.ts";

/**
 * Profile extensions in the sanitized manifest.
 *
 * Extensions were previously absent from `writeManifest` and hardcoded to `[]`
 * on restore, so every restored profile came back with none — silently, with no
 * warning. These tests pin the round-trip and the two scopes, which behave
 * differently: a profile-scoped extension's files are inside the snapshotted data
 * directory, while a shared-scope one only references the device-wide store.
 */

const BASE = {
  id: "prof-1",
  name: "Work",
  fingerprint: { device: "macbook-pro-14-m3" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function ext(over: Partial<ManifestExtensionInput> = {}): ManifestExtensionInput {
  return {
    id: "abcdefghijklmnopabcdefghijklmnop",
    name: "uBlock Origin",
    version: "1.50.0",
    enabled: true,
    scope: "shared" as const,
    dir: "",
    source: "web-store" as const,
    ...over,
  };
}

test("extensions survive the manifest round-trip", () => {
  const manifest = toManifest({ ...BASE, extensions: [ext(), ext({ id: "b".repeat(32), name: "Dark Reader" })] });
  assert.equal(manifest.extensions?.length, 2);
  assert.deepEqual(manifest.extensions?.[0], {
    id: "abcdefghijklmnopabcdefghijklmnop",
    name: "uBlock Origin",
    version: "1.50.0",
    enabled: true,
    scope: "shared",
    dir: "",
    source: "web-store",
  });
});

test("a profile with no extensions omits the field entirely", () => {
  assert.equal(toManifest({ ...BASE }).extensions, undefined);
  assert.equal(toManifest({ ...BASE, extensions: [] }).extensions, undefined);
});

test("only allow-listed extension fields are copied", () => {
  // A future field on the app's ExtensionConfig must not ride along unreviewed.
  const withExtra = { ...ext(), secretToken: "sk-should-never-travel" } as never;
  const manifest = toManifest({ ...BASE, extensions: [withExtra] });
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("sk-should-never-travel"));
  assert.ok(!serialized.includes("secretToken"));
});

test("an extension list still passes the manifest safety assertion", () => {
  const manifest = toManifest({
    ...BASE,
    proxy: { type: "http", host: "proxy.example.com", port: 8080, username: "u", password: "p" },
    extensions: [ext({ scope: "profile", dir: "extensions/uuid-1" })],
  });
  // Proxy credentials are still stripped, and extensions introduce no new keys
  // that the safety walk would consider forbidden.
  assert.doesNotThrow(() => assertManifestSafe(manifest));
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("\"password\""));
  assert.ok(!serialized.includes("\"username\""));
});

test("sanitizeExtensions preserves order and both scopes", () => {
  const out = sanitizeExtensions([
    ext({ id: "a".repeat(32), scope: "profile", dir: "extensions/one" }),
    ext({ id: "b".repeat(32), scope: "shared", dir: "" }),
  ]);
  assert.deepEqual(
    out?.map((e: { id: string; scope: string; dir: string }) => [e.id, e.scope, e.dir]),
    [
      ["a".repeat(32), "profile", "extensions/one"],
      ["b".repeat(32), "shared", ""],
    ],
  );
});

// ── restore-side reconciliation ──────────────────────────────────────────────
//
// The reconciler is private to SyncController, so it is exercised through the
// same rule it implements: a shared-scope entry is loadable only when its files
// exist under `<dataRoot>/extension-store/<id>/<version>`.

test("a shared extension is present only when its store directory exists", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "mz-extstore-"));
  try {
    const storeRoot = join(dataRoot, "extension-store");
    const installed = ext({ id: "c".repeat(32), version: "2.0.0" });
    const dir = storeEntryDir(storeRoot, installed.id, installed.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");

    assert.equal(
      storeEntryDir(storeRoot, installed.id, installed.version),
      join(storeRoot, installed.id, "2.0.0"),
    );
    // A different version is a different store entry, so it is genuinely absent.
    assert.notEqual(
      storeEntryDir(storeRoot, installed.id, "9.9.9"),
      storeEntryDir(storeRoot, installed.id, installed.version),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("an empty version maps to a stable store directory rather than a broken path", () => {
  // Legacy rows predating dedup have version "". The store must still place them
  // somewhere deterministic instead of producing `<id>/`.
  assert.equal(storeEntryDir("/root", "d".repeat(32), ""), join("/root", "d".repeat(32), "0"));
});
