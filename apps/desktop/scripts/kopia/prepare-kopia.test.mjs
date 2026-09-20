/**
 * Unit tests for prepare-kopia's offline-safe pieces: the dry-run plan (no
 * download, no writes) and the in-process tar parser + gunzip round-trip.
 *
 * No network. The only fs touch is a tmp gz buffer built purely in memory via
 * node:zlib; nothing is written to the project tree.
 *
 * Run: node --test scripts/kopia/prepare-kopia.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import {
  prepareKopia,
  iterateTarFiles,
  gunzipBuffer,
  sha256Hex,
} from "./prepare-kopia.mjs";
import { EMBEDDED_LICENSE_NAME, EMBEDDED_NOTICE_NAME, KOPIA_MAC_ASSETS } from "./kopiaAssets.mjs";

// ── dry run makes no network / fs calls ──────────────────────────────────

test("prepareKopia dry-run returns the plan without downloading or writing", async () => {
  const destDir = "/tmp/does-not-exist-kopia-dest";
  const result = await prepareKopia({ arch: "arm64", destDir, dryRun: true });
  assert.equal(result.action, "dry-run");
  assert.equal(result.arch, "arm64");
  assert.equal(result.version, "0.23.1");
  assert.equal(result.expectedSha256, KOPIA_MAC_ASSETS.arm64.sha256);
  assert.equal(result.binPath, join(destDir, "kopia"));
  assert.equal(result.licensePath, join(destDir, EMBEDDED_LICENSE_NAME));
  assert.equal(result.noticePath, join(destDir, EMBEDDED_NOTICE_NAME));
  assert.ok(result.url.startsWith("https://"));
});

test("prepareKopia rejects an unsupported arch before any I/O", async () => {
  await assert.rejects(
    () => prepareKopia({ arch: "riscv64", destDir: "/tmp/x", dryRun: true }),
    /unsupported macOS arch/,
  );
});

// ── tar parser ────────────────────────────────────────────────────────────

/** Build a single ustar file entry (512 header + padded data). */
function tarFileEntry(name, data, mode = 0o644) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8"); // name @ 0..100
  header.write((mode & 0o7777).toString(8).padStart(7, "0") + "\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size
  header.write("00000000000\0", 136, "ascii"); // mtime
  header.write("        ", 148, "ascii"); // checksum placeholder (spaces)
  header.write("0", 156, "ascii"); // typeflag = regular file
  header.write("ustar\0", 257, "ascii"); // magic
  header.write("00", 263, "ascii"); // version
  // Compute + write header checksum.
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function buildTar(entries) {
  const parts = entries.map((e) => tarFileEntry(e.name, Buffer.from(e.data), e.mode));
  // Two trailing zero blocks terminate the archive.
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test("iterateTarFiles yields regular files with names + data", () => {
  const tar = buildTar([
    { name: "kopia-0.23.1-macOS-arm64/kopia", data: "BINARY", mode: 0o755 },
    { name: "kopia-0.23.1-macOS-arm64/LICENSE", data: "Apache 2.0", mode: 0o644 },
  ]);
  const files = [...iterateTarFiles(tar)];
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "kopia-0.23.1-macOS-arm64/kopia");
  assert.equal(files[0].data.toString(), "BINARY");
  assert.equal(files[0].mode & 0o777, 0o755);
  assert.equal(files[1].name, "kopia-0.23.1-macOS-arm64/LICENSE");
  assert.equal(files[1].data.toString(), "Apache 2.0");
});

test("gunzipBuffer + sha256Hex round-trip a gzipped tar", async () => {
  const tar = buildTar([{ name: "kopia/kopia", data: "hello" }]);
  const gz = gzipSync(tar);
  const back = await gunzipBuffer(gz);
  assert.ok(back.equals(tar));
  // sha256Hex is deterministic + 64 hex chars.
  const digest = sha256Hex(gz);
  assert.match(digest, /^[0-9a-f]{64}$/);
});
