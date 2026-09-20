/**
 * Deterministic fetch + prepare of the pinned Kopia macOS binary.
 *
 * Guarantees:
 *   - HTTPS only (node:https). No shell is ever invoked (no child_process at
 *     all): download, gunzip (node:zlib) and tar extraction are pure Node.
 *   - The archive SHA-256 (node:crypto) is verified against the pinned value
 *     BEFORE a single byte is extracted. A mismatch aborts with a clear error.
 *   - Extraction resolves every member through {@link safeExtractPath}, so a
 *     crafted archive can't escape the destination directory.
 *   - The embedded binary is written with mode 0o755 (executable) under a
 *     DETERMINISTIC name (`kopia`) that kopiaFactory resolves at runtime.
 *   - The upstream Apache-2.0 LICENSE + a provenance NOTICE ship alongside it.
 *   - After extraction the binary's reported version is verified to match the
 *     pinned version (best-effort; skipped when host arch != target arch,
 *     since a cross-arch binary can't be executed on the build host).
 *
 * Usage:
 *   node scripts/kopia/prepare-kopia.mjs --arch=arm64 [--dest=resources/kopia]
 *   node scripts/kopia/prepare-kopia.mjs --arch=x64
 *   node scripts/kopia/prepare-kopia.mjs           # defaults to process.arch
 *   node scripts/kopia/prepare-kopia.mjs --dry-run # print plan, touch nothing
 *
 * On a non-macOS host/platform this is an explicit no-op (upstream Windows and
 * Linux builds do not embed Kopia; the resolver falls back to PATH there).
 */

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import * as pathApi from "node:path";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpsGet } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  KOPIA_VERSION,
  EMBEDDED_BINARY_NAME,
  EMBEDDED_LICENSE_NAME,
  EMBEDDED_NOTICE_NAME,
  buildKopiaNotice,
  selectMacAsset,
  downloadUrlFor,
  assertChecksum,
  safeExtractPath,
} from "./kopiaAssets.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/kopia -> apps/desktop
const DESKTOP_ROOT = resolve(HERE, "..", "..");
const DEFAULT_DEST = join(DESKTOP_ROOT, "resources", "kopia");

/** Parse `--k=v` / `--flag` CLI args into a map. */
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/** Download `url` over HTTPS into memory, following GitHub's redirect. */
function downloadToBuffer(url, redirectsLeft = 5) {
  if (!url.startsWith("https://")) {
    return Promise.reject(new Error(`refusing non-HTTPS URL: ${url}`));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          rejectPromise(new Error("too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        resolvePromise(downloadToBuffer(next, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        rejectPromise(new Error(`download failed: HTTP ${status} for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolvePromise(Buffer.concat(chunks)));
      res.on("error", rejectPromise);
    });
    req.on("error", rejectPromise);
  });
}

/** SHA-256 hex digest of a buffer. */
export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Gunzip a buffer to a buffer using node:zlib streams. */
export function gunzipBuffer(gzBuf) {
  return new Promise((resolvePromise, rejectPromise) => {
    const gunzip = createGunzip();
    const chunks = [];
    gunzip.on("data", (c) => chunks.push(c));
    gunzip.on("end", () => resolvePromise(Buffer.concat(chunks)));
    gunzip.on("error", rejectPromise);
    gunzip.end(gzBuf);
  });
}

/**
 * Minimal, read-only ustar/gnu tar parser. Yields regular-file entries as
 * `{ name, mode, data }`. Skips directories and other typeflags. No external
 * `tar` binary, no shell.
 */
export function* iterateTarFiles(tarBuf) {
  const BLOCK = 512;
  let offset = 0;
  let longName = null;
  while (offset + BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const rawName = readString(header, 0, 100);
    const mode = parseInt(readString(header, 100, 8).trim() || "0", 8) || 0;
    const size = parseOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);
    offset += BLOCK;

    const dataStart = offset;
    const dataEnd = dataStart + size;
    // Advance past the file data, padded to a 512-byte boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;

    // GNU long name extension ('L'): the next entry's name is this payload.
    if (typeFlag === "L") {
      longName = tarBuf.subarray(dataStart, dataEnd).toString("utf8").replace(/\0+$/, "");
      continue;
    }

    const name = longName ?? rawName;
    longName = null;

    // Regular file: typeflag '0' or NUL.
    if (typeFlag === "0" || typeFlag === "\u0000") {
      yield { name, mode, data: tarBuf.subarray(dataStart, dataEnd) };
    }
    // Everything else (dirs '5', symlinks '2', etc.) is skipped.
  }
}

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString("utf8");
}

function parseOctal(buf, start, len) {
  const s = readString(buf, start, len).trim();
  return s.length ? parseInt(s, 8) : 0;
}

/**
 * Prepare the pinned Kopia binary for `arch` into `destDir`. Returns a plan
 * object describing what happened (used by both the CLI and tests). When
 * `dryRun` is true, nothing is written or downloaded.
 */
export async function prepareKopia({ arch, destDir, dryRun = false, hostArch = process.arch }) {
  const asset = selectMacAsset(arch);
  const url = downloadUrlFor(arch);
  const binPath = join(destDir, EMBEDDED_BINARY_NAME);
  const plan = {
    version: KOPIA_VERSION,
    arch,
    url,
    expectedSha256: asset.sha256,
    destDir,
    binPath,
    licensePath: join(destDir, EMBEDDED_LICENSE_NAME),
    noticePath: join(destDir, EMBEDDED_NOTICE_NAME),
    dryRun,
  };
  if (dryRun) return { ...plan, action: "dry-run" };

  // 1. Download over HTTPS into memory.
  const gzBuf = await downloadToBuffer(url);

  // 2. Verify checksum BEFORE touching the archive contents.
  assertChecksum(arch, sha256Hex(gzBuf));

  // 3. Gunzip + parse the tar entirely in-process (no shell).
  const tarBuf = await gunzipBuffer(gzBuf);

  let binData = null;
  let binMode = 0o755;
  let licenseText = null;
  for (const entry of iterateTarFiles(tarBuf)) {
    // Validate every member resolves safely under destDir even though we only
    // write two of them — this exercises the traversal guard on real input.
    safeExtractPath(destDir, entry.name, pathApi);
    if (entry.name === asset.innerBinaryPath) {
      binData = Buffer.from(entry.data);
      // Always ship as executable regardless of the archived mode bits.
      binMode = (entry.mode & 0o777) | 0o755;
    } else if (entry.name === asset.innerLicensePath) {
      licenseText = Buffer.from(entry.data).toString("utf8");
    }
  }
  if (!binData) {
    throw new Error(`kopia binary not found in archive at ${asset.innerBinaryPath}`);
  }

  // 4. Write binary + license/notice atomically into a clean dest.
  await mkdir(destDir, { recursive: true });
  await writeFileAtomic(binPath, binData);
  // Always executable, owner rwx + group/other rx.
  await chmod(binPath, 0o755);
  await writeFile(
    plan.licensePath,
    licenseText ?? "Apache License 2.0 — see https://github.com/kopia/kopia/blob/master/LICENSE\n",
  );
  await writeFile(plan.noticePath, buildKopiaNotice(arch));

  // 5. Verify the binary reports the pinned version — only when we can run it
  //    (host arch must match the target arch; a cross-arch binary won't exec).
  let versionVerified = false;
  if (hostArch === arch) {
    const { stdout } = await execFileAsync(binPath, ["--version"], { timeout: 15_000 });
    const reported = String(stdout).trim();
    if (!reported.startsWith(KOPIA_VERSION)) {
      throw new Error(
        `kopia version mismatch: binary reports ${JSON.stringify(reported)}, expected ${KOPIA_VERSION}`,
      );
    }
    versionVerified = true;
  }

  return { ...plan, action: "prepared", mode: binMode & 0o777, versionVerified };
}

/** Write `data` to `path` via a temp file + rename (atomic on the same dir). */
async function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await new Promise((resolvePromise, rejectPromise) => {
    const ws = createWriteStream(tmp, { mode: 0o755 });
    ws.on("error", rejectPromise);
    ws.on("finish", resolvePromise);
    ws.end(data);
  });
  await rm(path, { force: true });
  await rename(tmp, path);
}

/** CLI entrypoint. */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  // Explicit, documented no-op on non-macOS. Upstream Windows/Linux builds do
  // not embed Kopia; the runtime resolver falls back to a PATH lookup there.
  if (process.platform !== "darwin") {
    process.stdout.write(
      `[prepare-kopia] platform ${process.platform} is not macOS — nothing to embed (no-op).\n`,
    );
    return;
  }

  const arch = typeof args.arch === "string" && args.arch.length ? args.arch : process.arch;
  const destDir = typeof args.dest === "string" && args.dest.length ? resolve(args.dest) : DEFAULT_DEST;

  const result = await prepareKopia({ arch, destDir, dryRun });
  if (dryRun) {
    process.stdout.write(
      `[prepare-kopia] DRY RUN — would download ${result.url}\n` +
        `  sha256 (expected): ${result.expectedSha256}\n` +
        `  -> ${result.binPath} (mode 0755) + ${EMBEDDED_LICENSE_NAME} + ${EMBEDDED_NOTICE_NAME}\n`,
    );
    return;
  }
  process.stdout.write(
    `[prepare-kopia] embedded kopia ${result.version} (${result.arch}) at ${result.binPath}` +
      `${result.versionVerified ? " (version verified)" : " (cross-arch: version check skipped)"}\n`,
  );
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`[prepare-kopia] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
