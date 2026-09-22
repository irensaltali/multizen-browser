#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
KOPIA_BIN="$ROOT_DIR/apps/desktop/resources/kopia/kopia"
CHECK_ONLY=false
SKIP_INSTALL=false
DEV_ARGS=()
DEV_ARG_COUNT=0

usage() {
  cat <<'EOF'
Usage: ./dev.sh [options] [-- electron-vite arguments]

Prepare and launch the MultiZen desktop app in development mode.

Options:
  --check         Prepare everything and exit without opening the app.
  --skip-install  Skip the immutable Yarn dependency check/install.
  -h, --help      Show this help.

Examples:
  ./dev.sh
  ./dev.sh --check
  ./dev.sh --skip-install
EOF
}

while (($# > 0)); do
  case "$1" in
    --check)
      CHECK_ONLY=true
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while (($# > 0)); do
        DEV_ARGS[$DEV_ARG_COUNT]="$1"
        DEV_ARG_COUNT=$((DEV_ARG_COUNT + 1))
        shift
      done
      ;;
    *)
      DEV_ARGS[$DEV_ARG_COUNT]="$1"
      DEV_ARG_COUNT=$((DEV_ARG_COUNT + 1))
      shift
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'error: this development launcher currently supports macOS only.\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'error: Node.js 20 or newer is required. Install Node.js, then retry.\n' >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || ((NODE_MAJOR < 20)); then
  printf 'error: Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

if ! command -v corepack >/dev/null 2>&1; then
  printf 'error: Corepack is required but was not found in PATH.\n' >&2
  exit 1
fi

cd "$ROOT_DIR"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

printf '[dev] repository: %s\n' "$ROOT_DIR"
printf '[dev] node: %s\n' "$(node --version)"

if [[ "$SKIP_INSTALL" == false ]]; then
  printf '[dev] checking locked dependencies...\n'
  corepack yarn install --immutable
else
  printf '[dev] skipping dependency install/check.\n'
fi

printf '[dev] preparing pinned Kopia binary...\n'
corepack yarn workspace @multizen/desktop prepare:kopia

if [[ ! -x "$KOPIA_BIN" ]]; then
  printf 'error: Kopia was not prepared at %s.\n' "$KOPIA_BIN" >&2
  exit 1
fi

export MULTIZEN_KOPIA_BIN="$KOPIA_BIN"
printf '[dev] Kopia: %s\n' "$("$KOPIA_BIN" --version | head -n 1)"

if [[ "$CHECK_ONLY" == true ]]; then
  printf '[dev] ready. Run ./dev.sh to launch MultiZen.\n'
  exit 0
fi

printf '[dev] launching MultiZen; press Ctrl+C to stop.\n'
if ((DEV_ARG_COUNT > 0)); then
  exec corepack yarn dev "${DEV_ARGS[@]}"
else
  exec corepack yarn dev
fi
