/**
 * electron-builder afterPack hook.
 *
 * On macOS the app bundle is (ad-hoc or Developer ID) signed by electron-builder,
 * but a nested Mach-O executable we ship under Contents/Resources (the embedded
 * Kopia binary) is NOT covered by the app signature and would fail Gatekeeper's
 * exec check when the sync controller spawns it. This hook signs that binary
 * with the SAME identity the build uses:
 *   - a real Developer ID when CSC_NAME / mac.identity is a certificate name, or
 *   - ad-hoc ("-") for the open-source unsigned build (the default here).
 *
 * codesign is invoked shell-free via execFile (argv array, no shell string).
 * On non-macOS platforms this is an explicit no-op.
 */

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const execFileAsync = promisify(execFile);

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") {
    // Windows/Linux: nothing to sign here. Their builds don't embed Kopia and
    // the resolver falls back to PATH.
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appBundle = join(appOutDir, `${appName}.app`);
  const resourcesDir = join(appBundle, "Contents", "Resources", "kopia");
  const kopiaBin = join(resourcesDir, "kopia");
  if (!existsSync(kopiaBin)) {
    // No embedded binary in this build (e.g. prepare-kopia was skipped).
    // Leave a breadcrumb but don't fail the build — Cloud Sync simply falls
    // back to a PATH lookup at runtime.
    process.stdout.write(
      `[afterPack] no embedded kopia at ${kopiaBin} — skipping codesign (sync will use PATH).\n`,
    );
    return;
  }

  // Prefer the identity electron-builder is configured with; default to ad-hoc.
  const macConfig = packager.platformSpecificBuildOptions || {};
  const identity =
    process.env.CSC_NAME ||
    (typeof macConfig.identity === "string" && macConfig.identity.length ? macConfig.identity : "-");

  const args = [
    "--force",
    "--sign",
    identity,
    "--timestamp=none",
    "--options",
    "runtime",
    kopiaBin,
  ];
  // Ad-hoc signatures ("-") can't use the hardened runtime option; drop it.
  if (identity === "-") {
    args.splice(args.indexOf("--options"), 2);
  }

  try {
    await execFileAsync("codesign", args, { timeout: 60_000 });
    process.stdout.write(
      `[afterPack] codesigned embedded kopia with identity ${identity === "-" ? "ad-hoc" : identity}.\n`,
    );

    // electron-builder 25 does not resolve `identity: "-"` as an installed
    // signing identity and therefore skips its own app-level signing step. In
    // the open-source build, seal the complete bundle ourselves after all
    // nested executables are signed. A real Developer ID build is left to
    // electron-builder's normal signing/notarization flow.
    if (identity === "-") {
      await execFileAsync(
        "codesign",
        ["--force", "--deep", "--sign", "-", "--timestamp=none", appBundle],
        { timeout: 120_000 },
      );
      process.stdout.write("[afterPack] ad-hoc codesigned complete MultiZen app bundle.\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[afterPack] failed to codesign packaged app: ${msg}`);
  }
};
