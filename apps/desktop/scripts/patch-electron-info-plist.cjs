#!/usr/bin/env node
/**
 * In dev mode the app runs as `node_modules/electron/dist/Electron.app`,
 * and macOS reads `CFBundleDisplayName` / `CFBundleName` from that
 * bundle's Info.plist for the dock tooltip and the menu bar app name.
 * Electron's `app.setName('MultiZen')` does NOT override these — it only
 * affects the About panel and `app.getName()`.
 *
 * Production builds use electron-builder which generates a fresh
 * Info.plist from `productName`, so this script is dev-only.
 *
 * Idempotent: safe to run on every `yarn dev`.
 */
const fs = require("node:fs");
const path = require("node:path");

const APP_NAME = require("../../../../branding/brand.json").name;
// Distinct from the production bundle id (`com.multizen.app`) so dev and
// prod keep separate macOS preferences / Launch Services entries.
const APP_ID = "com.multizen.dev";
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const candidates = [
  // Hoisted at desktop workspace level (yarn 4 node-modules linker is unpredictable).
  path.join(__dirname, "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "Info.plist"),
  // Hoisted at root.
  path.join(repoRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "Info.plist"),
];
const plistPath = candidates.find((p) => fs.existsSync(p));
if (!plistPath) {
  // Linux / Windows dev or Electron not installed — nothing to do.
  process.exit(0);
}

const original = fs.readFileSync(plistPath, "utf8");
let patched = original;
patched = patched.replace(
  /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${APP_NAME}$2`,
);
patched = patched.replace(
  /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${APP_NAME}$2`,
);
patched = patched.replace(
  /(<key>CFBundleIdentifier<\/key>\s*<string>)com\.github\.Electron(<\/string>)/,
  `$1${APP_ID}$2`,
);
if (patched !== original) {
  fs.writeFileSync(plistPath, patched);
  console.log(`[multizen] Patched ${path.relative(repoRoot, plistPath)} → ${APP_NAME} / ${APP_ID}`);
}

// Some macOS versions read names from `Contents/Resources/en.lproj/InfoPlist.strings`
// in preference to the main Info.plist. Write our own so dock + menu
// bar agree across all paths macOS might consult.
const appPath = path.dirname(path.dirname(plistPath));
const enLproj = path.join(appPath, "Contents", "Resources", "en.lproj");
const stringsPath = path.join(enLproj, "InfoPlist.strings");
try {
  fs.mkdirSync(enLproj, { recursive: true });
  // Plain UTF-8 (modern macOS reads it). Quoted strings, semicolon-terminated.
  const content =
    `CFBundleName = "${APP_NAME}";\n` +
    `CFBundleDisplayName = "${APP_NAME}";\n` +
    `CFBundleGetInfoString = "${APP_NAME}";\n`;
  const existing = fs.existsSync(stringsPath) ? fs.readFileSync(stringsPath, "utf8") : "";
  if (existing !== content) {
    fs.writeFileSync(stringsPath, content);
    console.log(`[multizen] Wrote ${path.relative(repoRoot, stringsPath)}`);
  }
} catch (e) {
  console.warn("[multizen] InfoPlist.strings write skipped:", e.message);
}

const { execFileSync } = require("node:child_process");
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
try {
  // Touch the .app so LS notices a change.
  fs.utimesSync(appPath, new Date(), new Date());
  execFileSync(lsregister, ["-f", appPath], { stdio: "ignore" });
  console.log("[multizen] Refreshed Launch Services cache for", path.basename(appPath));
} catch (e) {
  console.warn("[multizen] lsregister refresh skipped:", e.message);
}
