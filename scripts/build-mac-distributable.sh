#!/usr/bin/env bash
#
# Build a macOS DMG and ZIP that can be copied to another Mac for testing.
#
# Usage:
#   yarn dist:mac          # build for this Mac's architecture
#   yarn dist:mac arm64    # build for Apple Silicon
#   yarn dist:mac x64      # build for Intel

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
ARCH="${1:-$(uname -m)}"

case "$ARCH" in
  arm64) ;;
  x64 | x86_64) ARCH="x64" ;;
  -h | --help)
    sed -n '2,9p' "$0"
    exit 0
    ;;
  *)
    echo "error: unsupported architecture '$ARCH' (use arm64 or x64)" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS distributables must be built on macOS" >&2
  exit 1
fi

if ! command -v yarn >/dev/null 2>&1; then
  echo "error: Yarn is required; run 'corepack enable' first" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "error: dependencies are missing; run 'yarn install' first" >&2
  exit 1
fi

RELEASE_DIR="$DESKTOP_DIR/release"
BUNDLE_DIR="$ROOT_DIR/dist/macos-$ARCH"
DMG_NAME="MultiZen-mac-$ARCH.dmg"
ZIP_NAME="MultiZen-mac-$ARCH.zip"

echo "Building MultiZen for macOS $ARCH..."

rm -f "$RELEASE_DIR/$DMG_NAME" "$RELEASE_DIR/$ZIP_NAME"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

# The previous package run removes apps/desktop/node_modules/@multizen so
# electron-builder cannot follow workspace symlinks outside the app directory.
# Restore those links before Vite resolves the workspace imports. This also
# makes consecutive `yarn dist:mac` runs work without a manual reinstall.
yarn install --immutable

node "$DESKTOP_DIR/scripts/kopia/prepare-kopia.mjs" --arch="$ARCH"
yarn workspace @multizen/desktop exec electron-vite build
node "$DESKTOP_DIR/scripts/strip-workspace-symlinks.cjs"
yarn workspace @multizen/desktop exec electron-builder --mac --"$ARCH"

for artifact in "$DMG_NAME" "$ZIP_NAME"; do
  if [[ ! -f "$RELEASE_DIR/$artifact" ]]; then
    echo "error: expected artifact was not created: $RELEASE_DIR/$artifact" >&2
    exit 1
  fi
  cp "$RELEASE_DIR/$artifact" "$BUNDLE_DIR/"
done

(
  cd "$BUNDLE_DIR"
  shasum -a 256 "$DMG_NAME" "$ZIP_NAME" > SHA256SUMS
)

cat > "$BUNDLE_DIR/INSTALL.txt" <<EOF
MultiZen test build for macOS $ARCH

1. Open $DMG_NAME and drag MultiZen into Applications.
2. Because this test build is not Apple-notarized, run:

   xattr -cr /Applications/MultiZen.app

3. Open MultiZen from Applications.

To verify the copied files:

   shasum -a 256 -c SHA256SUMS
EOF

echo
echo "Distributable bundle created:"
echo "  $BUNDLE_DIR"
echo
echo "Copy that folder to the other Mac and follow INSTALL.txt."
