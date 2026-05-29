#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

ELECTRON_VERSION="$(cd "$DESKTOP_DIR" && node -p "require('./node_modules/electron/package.json').version")"
REBUILD_BIN="$DESKTOP_DIR/node_modules/.bin/electron-rebuild"
BUILDER_BIN="$DESKTOP_DIR/node_modules/.bin/electron-builder"
SQLITE_NODE="$ROOT_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

restore_host_native() {
  echo "-> Restoring better-sqlite3 for host Node ABI"
  (cd "$ROOT_DIR" && npm rebuild better-sqlite3 >/dev/null 2>&1) || true
}

trap restore_host_native EXIT

verify_native_arch() {
  local arch="$1"
  local expected="$2"
  local actual
  actual="$(file "$SQLITE_NODE")"
  echo "   better-sqlite3 native: $actual"
  if [[ "$actual" != *"$expected"* ]]; then
    echo "::error::better-sqlite3 native module is not $expected for $arch build"
    exit 1
  fi
}

build_arch() {
  local arch="$1"
  local expected="$2"
  echo "-> Rebuilding daemon native modules for Electron $ELECTRON_VERSION ($arch)"
  (cd "$ROOT_DIR" && "$REBUILD_BIN" \
    --version "$ELECTRON_VERSION" \
    --module-dir . \
    --types prod \
    --force \
    --only better-sqlite3 \
    --arch "$arch")
  verify_native_arch "$arch" "$expected"

  echo "-> Building macOS artifacts ($arch)"
  (cd "$DESKTOP_DIR" && "$BUILDER_BIN" --mac dmg zip "--$arch" --publish never)
}

echo "-> Building desktop shell"
(cd "$DESKTOP_DIR" && npm run build)

echo "-> Building daemon"
(cd "$ROOT_DIR" && npm run build)

echo "-> Building mobile web app"
(cd "$ROOT_DIR" && npm run build:mobile-web)

build_arch arm64 arm64
build_arch x64 x86_64
