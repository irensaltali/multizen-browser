/**
 * Unit tests for the pinned-Kopia asset helpers.
 *
 * These exercise asset selection, checksum verification (match + mismatch),
 * URL construction (HTTPS-only), and safe archive-path resolution. NONE of
 * them touch the network or the filesystem — they run offline in CI.
 *
 * Run: node --test scripts/kopia/kopiaAssets.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import {
  KOPIA_VERSION,
  KOPIA_MAC_ASSETS,
  SUPPORTED_MAC_ARCHES,
  EMBEDDED_BINARY_NAME,
  buildKopiaNotice,
  selectMacAsset,
  downloadUrlFor,
  assertChecksum,
  safeExtractPath,
} from "./kopiaAssets.mjs";

// ── Pinned metadata ──────────────────────────────────────────────────────

test("pins Kopia v0.23.1 with the official macOS checksums", () => {
  assert.equal(KOPIA_VERSION, "0.23.1");
  assert.equal(
    KOPIA_MAC_ASSETS.arm64.sha256,
    "19e6ed637221f4dfd46a46e978ec4c509c386b522d746db2cd6762b217478111",
  );
  assert.equal(
    KOPIA_MAC_ASSETS.x64.sha256,
    "89dd7160a1266413c73bd0aa92459c5e739fcaed2ba30a4cca30aef179f11042",
  );
  assert.equal(KOPIA_MAC_ASSETS.arm64.fileName, "kopia-0.23.1-macOS-arm64.tar.gz");
  assert.equal(KOPIA_MAC_ASSETS.x64.fileName, "kopia-0.23.1-macOS-x64.tar.gz");
  assert.deepEqual([...SUPPORTED_MAC_ARCHES], ["arm64", "x64"]);
});

// ── Asset selection ──────────────────────────────────────────────────────

test("selectMacAsset returns the matching pinned asset", () => {
  assert.equal(selectMacAsset("arm64").arch, "arm64");
  assert.equal(selectMacAsset("x64").arch, "x64");
});

test("selectMacAsset throws for unsupported arch", () => {
  assert.throws(() => selectMacAsset("ppc64"), /unsupported macOS arch/);
  assert.throws(() => selectMacAsset("universal"), /unsupported macOS arch/);
  assert.throws(() => selectMacAsset(undefined), /unsupported macOS arch/);
});

// ── URL construction (HTTPS only) ────────────────────────────────────────

test("downloadUrlFor builds an HTTPS github release URL", () => {
  const url = downloadUrlFor("arm64");
  assert.ok(url.startsWith("https://github.com/kopia/kopia/releases/download/v0.23.1/"));
  assert.ok(url.endsWith("kopia-0.23.1-macOS-arm64.tar.gz"));
});

// ── Checksum verification ────────────────────────────────────────────────

test("assertChecksum accepts the pinned digest (case-insensitive)", () => {
  assert.equal(assertChecksum("arm64", KOPIA_MAC_ASSETS.arm64.sha256), true);
  assert.equal(assertChecksum("x64", KOPIA_MAC_ASSETS.x64.sha256.toUpperCase()), true);
});

test("assertChecksum throws on a mismatch and names the file", () => {
  assert.throws(
    () => assertChecksum("arm64", "0".repeat(64)),
    (err) =>
      err instanceof Error &&
      /checksum mismatch/.test(err.message) &&
      err.message.includes("kopia-0.23.1-macOS-arm64.tar.gz"),
  );
});

test("assertChecksum rejects the wrong-arch digest (arm64 blob under x64)", () => {
  assert.throws(
    () => assertChecksum("x64", KOPIA_MAC_ASSETS.arm64.sha256),
    /checksum mismatch/,
  );
});

// ── Safe extraction path resolution ──────────────────────────────────────

test("safeExtractPath resolves a normal member under the destination", () => {
  const target = safeExtractPath("/dest", "kopia-0.23.1-macOS-arm64/kopia", posix);
  assert.equal(target, "/dest/kopia-0.23.1-macOS-arm64/kopia");
});

test("safeExtractPath allows the root dir entry equal to destDir", () => {
  const target = safeExtractPath("/dest", ".", posix);
  assert.equal(target, "/dest");
});

test("safeExtractPath rejects parent-traversal members", () => {
  assert.throws(() => safeExtractPath("/dest", "../evil", posix), /escapes destination/);
  assert.throws(
    () => safeExtractPath("/dest", "kopia/../../etc/passwd", posix),
    /escapes destination/,
  );
});

test("safeExtractPath rejects absolute member names", () => {
  assert.throws(() => safeExtractPath("/dest", "/etc/passwd", posix), /absolute path/);
});

test("safeExtractPath rejects windows absolute member names", () => {
  assert.throws(() => safeExtractPath("C:/dest", "C:/Windows/system32", win32), /absolute path/);
});

test("safeExtractPath rejects NUL bytes and empty names", () => {
  assert.throws(() => safeExtractPath("/dest", "kop\0ia", posix), /NUL byte/);
  assert.throws(() => safeExtractPath("/dest", "", posix), /empty name/);
});

// ── Notice / license provenance ──────────────────────────────────────────

test("buildKopiaNotice records version, asset, and Apache-2.0 provenance", () => {
  const notice = buildKopiaNotice("x64");
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /Pinned version: 0\.23\.1/);
  assert.match(notice, /kopia-0\.23\.1-macOS-x64\.tar\.gz/);
  assert.match(notice, new RegExp(KOPIA_MAC_ASSETS.x64.sha256));
});

test("embedded binary name is the deterministic 'kopia'", () => {
  assert.equal(EMBEDDED_BINARY_NAME, "kopia");
});
