/**
 * Deterministic Kopia release-asset metadata + pure helpers.
 *
 * This module is intentionally free of any I/O (no network, no fs) so it can be
 * unit-tested without downloading anything. It pins EXACTLY one Kopia version
 * and the official SHA-256 checksums for the two macOS tarballs MultiZen ships.
 *
 * The checksums here are copied verbatim from the official `checksums.txt`
 * published on the Kopia GitHub release
 * (https://github.com/kopia/kopia/releases/tag/v0.23.1) and MUST be verified
 * before any archive is extracted.
 */

/** The single Kopia version MultiZen pins. Bumping requires new checksums. */
export const KOPIA_VERSION = "0.23.1";

/** Official GitHub release download host. HTTPS only — never plain HTTP. */
export const KOPIA_RELEASE_BASE = `https://github.com/kopia/kopia/releases/download/v${KOPIA_VERSION}`;

/**
 * Pinned, verified macOS assets keyed by Electron/Node arch id.
 *
 * `sha256` values are the official checksums for v0.23.1. `innerBinaryPath` is
 * the exact path of the `kopia` executable inside the tarball
 * (`kopia-<version>-macOS-<arch>/kopia`) — used to locate the binary during
 * safe extraction. `innerLicensePath` is the Apache-2.0 license the archive
 * carries; we copy it next to the embedded binary so the license/notice ships
 * with the app.
 */
export const KOPIA_MAC_ASSETS = Object.freeze({
  arm64: Object.freeze({
    arch: "arm64",
    fileName: `kopia-${KOPIA_VERSION}-macOS-arm64.tar.gz`,
    sha256: "19e6ed637221f4dfd46a46e978ec4c509c386b522d746db2cd6762b217478111",
    innerBinaryPath: `kopia-${KOPIA_VERSION}-macOS-arm64/kopia`,
    innerLicensePath: `kopia-${KOPIA_VERSION}-macOS-arm64/LICENSE`,
  }),
  x64: Object.freeze({
    arch: "x64",
    fileName: `kopia-${KOPIA_VERSION}-macOS-x64.tar.gz`,
    sha256: "89dd7160a1266413c73bd0aa92459c5e739fcaed2ba30a4cca30aef179f11042",
    innerBinaryPath: `kopia-${KOPIA_VERSION}-macOS-x64/kopia`,
    innerLicensePath: `kopia-${KOPIA_VERSION}-macOS-x64/LICENSE`,
  }),
});

/** Arch ids we know how to prepare on macOS. */
export const SUPPORTED_MAC_ARCHES = Object.freeze(["arm64", "x64"]);

/**
 * The deterministic file name the embedded binary is written under, and the
 * accompanying Apache-2.0 license/notice. `kopiaFactory.resolveKopiaBinary`
 * looks for exactly this name under `process.resourcesPath`.
 */
export const EMBEDDED_BINARY_NAME = "kopia";
export const EMBEDDED_LICENSE_NAME = "kopia-LICENSE.txt";
export const EMBEDDED_NOTICE_NAME = "kopia-NOTICE.txt";

/** A short provenance/notice we always write next to the embedded binary. */
export function buildKopiaNotice(arch) {
  const asset = selectMacAsset(arch);
  return [
    "MultiZen bundles the Kopia backup engine (https://kopia.io).",
    "",
    "Kopia is distributed under the Apache License, Version 2.0.",
    "The full license text ships alongside this notice as",
    `"${EMBEDDED_LICENSE_NAME}".`,
    "",
    `Pinned version: ${KOPIA_VERSION}`,
    `Source asset:   ${asset.fileName}`,
    `SHA-256:        ${asset.sha256}`,
    `Downloaded from ${KOPIA_RELEASE_BASE}/${asset.fileName}`,
    "",
    "No modifications are made to the upstream binary.",
    "",
  ].join("\n");
}

/**
 * Map a Node/Electron `process.arch` (or an explicit CLI arch) to the pinned
 * macOS asset. Throws for anything we don't ship, so a typo or an unexpected
 * arch fails loudly rather than silently downloading the wrong file.
 */
export function selectMacAsset(arch) {
  const asset = KOPIA_MAC_ASSETS[arch];
  if (!asset) {
    throw new Error(
      `unsupported macOS arch ${JSON.stringify(arch)}; expected one of ${SUPPORTED_MAC_ARCHES.join(
        ", ",
      )}`,
    );
  }
  return asset;
}

/** The full HTTPS download URL for a pinned asset. */
export function downloadUrlFor(arch) {
  const asset = selectMacAsset(arch);
  const url = `${KOPIA_RELEASE_BASE}/${asset.fileName}`;
  if (!url.startsWith("https://")) {
    throw new Error("refusing non-HTTPS Kopia download URL");
  }
  return url;
}

/**
 * Assert a computed digest matches the pinned checksum for `arch`. Comparison
 * is case-insensitive on the hex string. Throws a descriptive error on
 * mismatch — the caller MUST NOT proceed to extraction if this throws.
 */
export function assertChecksum(arch, computedHexDigest) {
  const asset = selectMacAsset(arch);
  const expected = asset.sha256.toLowerCase();
  const actual = String(computedHexDigest).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${asset.fileName}: expected ${expected}, got ${actual}`,
    );
  }
  return true;
}

/**
 * Resolve a member path from inside a tar archive to an absolute path under
 * `destDir`, refusing anything that would escape the destination (absolute
 * paths, `..` traversal, or a NUL byte encoded in the name).
 *
 * Pure string logic; the caller passes a `pathApi` (node:path) so this stays
 * testable and platform-explicit. Returns the safe absolute target path.
 */
export function safeExtractPath(destDir, memberName, pathApi) {
  const { resolve, sep, normalize, isAbsolute } = pathApi;
  if (typeof memberName !== "string" || memberName.length === 0) {
    throw new Error("archive member has an empty name");
  }
  if (memberName.includes("\0")) {
    throw new Error(`archive member name contains a NUL byte: ${JSON.stringify(memberName)}`);
  }
  if (memberName.startsWith("/") || isAbsolute(memberName)) {
    throw new Error(`archive member escapes with an absolute path: ${memberName}`);
  }
  const resolvedRoot = resolve(destDir);
  const target = resolve(resolvedRoot, normalize(memberName));
  // Must be inside destDir (or equal to it, for the root dir entry).
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new Error(`archive member escapes destination: ${memberName}`);
  }
  return target;
}
